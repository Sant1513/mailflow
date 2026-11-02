import { NextResponse, type NextRequest } from 'next/server';

/**
 * Front door for the server switch (lib/system/serverState.ts). MailFlow runs on the cloud
 * (this Vercel deployment + Supabase) unless the switch says "laptop", in which case every
 * request — pages, API calls, unsubscribe and tracking links in sent emails — is forwarded to
 * the laptop server's public address. During a handover everyone sees a short "switching
 * servers" page, so nothing is written to either database while it is being copied.
 *
 * The switch is read from /api/system/state (answered by this deployment, never forwarded)
 * and remembered for 10 seconds per edge instance.
 */
const STATE_PATH = '/api/system/state';
const ATTEMPTS = 3;

type EdgeState = { activeServer: 'cloud' | 'laptop'; switching: 'cloud' | 'laptop' | null; laptopUrl: string | null };
const CLOUD: EdgeState = { activeServer: 'cloud', switching: null, laptopUrl: null };
let cached: { at: number; state: EdgeState } | null = null;

async function serverState(req: NextRequest): Promise<EdgeState> {
  if (cached && Date.now() - cached.at < 10_000) return cached.state;
  try {
    const res = await fetch(new URL(STATE_PATH, req.nextUrl.origin), {
      headers: { 'x-mailflow-internal': process.env.CRON_SECRET ?? '' },
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      cached = { at: Date.now(), state: (await res.json()) as EdgeState };
      return cached.state;
    }
  } catch {}
  // Can't read the switch: keep the last known answer. With none, the cloud — which can only
  // write anything if its own database (where the switch lives) is reachable.
  return cached?.state ?? CLOUD;
}

function page(title: string, lines: string[], status: number) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>${title}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#f6f7f9;color:#1f2937;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:440px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 8px}p{margin:8px 0;line-height:1.5;color:#4b5563}
@media (prefers-color-scheme:dark){body{background:#111827;color:#f3f4f6}main{background:#1f2937;border-color:#374151}p{color:#d1d5db}}</style></head>
<body><main><h1>${title}</h1>${lines.map((l) => `<p>${l}</p>`).join('')}</main></body></html>`;
  return new NextResponse(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '30', 'cache-control': 'no-store' } });
}

function unavailable(req: NextRequest, title: string, lines: string[]) {
  const isPageVisit = req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html');
  return isPageVisit
    ? page(title, lines, 503)
    : new NextResponse(title, { status: 503, headers: { 'retry-after': '30', 'cache-control': 'no-store' } });
}

/** Forwards a read to the laptop, retrying when the connection fails. Null if every try failed. */
async function forwardRead(req: NextRequest, upstream: string): Promise<Response | null> {
  const publicOrigin = req.nextUrl.origin;
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.set('x-forwarded-host', req.nextUrl.host);
  headers.set('x-forwarded-proto', 'https');
  headers.set('accept-encoding', 'identity'); // Vercel compresses the reply to the browser itself

  // Vercel stops middleware at 25 s. Each try gets 7 s to *start* answering (the timer is
  // cleared once headers arrive, so a large download is never cut off), and no new try
  // starts after 18 s.
  const started = Date.now();
  for (let attempt = 1; attempt <= ATTEMPTS && Date.now() - started < 18_000; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(7_000, 22_000 - (Date.now() - started)));
    try {
      const res = await fetch(`${upstream}${req.nextUrl.pathname}${req.nextUrl.search}`, {
        method: req.method,
        headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      // 502/504 here come from the tunnel, not the app: the laptop side didn't answer.
      if ((res.status === 502 || res.status === 504) && attempt < ATTEMPTS) continue;
      const out = new Headers(res.headers);
      out.delete('content-encoding');
      out.delete('content-length');
      out.delete('transfer-encoding');
      // Redirects must be absolute here, and must point at the public address, not the laptop.
      const location = out.get('location');
      if (location) {
        const abs = new URL(location.startsWith(upstream) ? location.slice(upstream.length) || '/' : location, publicOrigin);
        out.set('location', abs.toString());
      }
      return new Response(req.method === 'HEAD' ? null : res.body, { status: res.status, statusText: res.statusText, headers: out });
    } catch {
      clearTimeout(timer);
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  return null;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === STATE_PATH) return NextResponse.next();

  const state = await serverState(req);

  if (state.switching) {
    return unavailable(req, 'MailFlow is switching servers', [
      `MailFlow is moving to the ${state.switching}. This takes about a minute, and nothing is lost: your work and sign-in carry over.`,
      'This page reloads by itself.',
    ]);
  }

  if (state.activeServer !== 'laptop' || !state.laptopUrl) return NextResponse.next();

  const upstream = state.laptopUrl.replace(/\/+$/, '');
  // The laptop runs its own schedule; Vercel's and GitHub's triggers would run every job twice.
  if (pathname.startsWith('/api/cron/')) {
    return NextResponse.json({ skipped: 'MailFlow is on the laptop, which runs its own schedule.' });
  }
  // Writes are forwarded once: retrying them could repeat an action.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return NextResponse.rewrite(new URL(pathname + req.nextUrl.search, upstream));
  }
  const res = await forwardRead(req, upstream);
  return (
    res ??
    unavailable(req, 'MailFlow is offline for a moment', [
      'The MailFlow server (on the laptop) is not reachable right now. Nothing is lost: emails that were waiting will go out as soon as it is back.',
      'If it stays offline, MailFlow moves to the cloud by itself after 10 minutes.',
    ])
  );
}

export const config = { matcher: '/:path*' };
