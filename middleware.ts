import { NextResponse, type NextRequest } from 'next/server';

/**
 * Laptop hosting. When LAPTOP_UPSTREAM is set (only on Vercel), this deployment is a front
 * door: every request — pages, API calls, crons, unsubscribe and tracking links in sent
 * emails — is forwarded to the MailFlow server running on the laptop (laptop-server/).
 * The public address and the Google sign-in setup stay the same.
 *
 * The route to the laptop (Tailscale Funnel over the laptop's internet) drops individual
 * connections now and then, so reads (GET/HEAD) are tried up to three times before giving up.
 * Writes (POST etc.) are forwarded once: retrying them could repeat an action. If the laptop
 * can't be reached, people opening a page get a short "offline" notice instead of an error.
 * Nothing is lost while it is off: queued emails wait in the laptop's database and sending
 * carries on when it is back.
 */
const UPSTREAM = process.env.LAPTOP_UPSTREAM?.replace(/\/+$/, '');
const ATTEMPTS = 3;

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>MailFlow is offline</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#f6f7f9;color:#1f2937;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:440px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 8px}p{margin:8px 0;line-height:1.5;color:#4b5563}
@media (prefers-color-scheme:dark){body{background:#111827;color:#f3f4f6}main{background:#1f2937;border-color:#374151}p{color:#d1d5db}}</style></head>
<body><main><h1>MailFlow is offline for a moment</h1><p>The MailFlow server is switched off or restarting. Nothing is lost: emails that were waiting will go out as soon as it is back.</p>
<p>This page checks again every minute.</p></main></body></html>`;

/** Forwards a read to the laptop, retrying when the connection fails. Null if every try failed. */
async function forwardRead(req: NextRequest): Promise<Response | null> {
  const publicOrigin = req.nextUrl.origin;
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.set('x-forwarded-host', req.nextUrl.host);
  headers.set('x-forwarded-proto', 'https');
  headers.set('accept-encoding', 'identity'); // Vercel compresses the reply to the browser itself

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${UPSTREAM}${req.nextUrl.pathname}${req.nextUrl.search}`, {
        method: req.method,
        headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      });
      // 502/504 here come from the tunnel, not the app: the laptop side didn't answer.
      if ((res.status === 502 || res.status === 504) && attempt < ATTEMPTS) continue;
      const out = new Headers(res.headers);
      out.delete('content-encoding');
      out.delete('content-length');
      out.delete('transfer-encoding');
      // Redirects must be absolute here, and must point at the public address, not the laptop.
      const location = out.get('location');
      if (location) {
        const abs = new URL(location.startsWith(UPSTREAM!) ? location.slice(UPSTREAM!.length) || '/' : location, publicOrigin);
        out.set('location', abs.toString());
      }
      return new Response(req.method === 'HEAD' ? null : res.body, { status: res.status, statusText: res.statusText, headers: out });
    } catch {
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  return null;
}

export async function middleware(req: NextRequest) {
  if (!UPSTREAM) return NextResponse.next();

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return NextResponse.rewrite(new URL(req.nextUrl.pathname + req.nextUrl.search, UPSTREAM));
  }

  const res = await forwardRead(req);
  if (res) return res;

  const isPageVisit = (req.headers.get('accept') ?? '').includes('text/html');
  return isPageVisit
    ? new NextResponse(OFFLINE_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60', 'cache-control': 'no-store' } })
    : new NextResponse('MailFlow server unreachable', { status: 503, headers: { 'retry-after': '60', 'cache-control': 'no-store' } });
}

export const config = { matcher: '/:path*' };
