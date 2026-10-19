import { NextResponse, type NextRequest } from 'next/server';

/**
 * Laptop hosting. When LAPTOP_UPSTREAM is set (only on Vercel), this deployment is a front
 * door: every request — pages, API calls, crons, unsubscribe and tracking links in sent
 * emails — is forwarded to the MailFlow server running on the laptop (laptop-server/).
 * The public address and the Google sign-in setup stay the same.
 *
 * If the laptop can't be reached, people opening a page get a short "offline" notice
 * instead of an error. Nothing is lost while it is off: queued emails wait in the laptop's
 * database and sending carries on when it is back.
 */
const UPSTREAM = process.env.LAPTOP_UPSTREAM?.replace(/\/+$/, '');

// Remember the last health check for a few seconds so a page load (HTML + assets) checks once.
let lastCheck = { at: 0, up: false };

async function upstreamIsUp(): Promise<boolean> {
  if (Date.now() - lastCheck.at < 15_000) return lastCheck.up;
  const up = await fetch(`${UPSTREAM}/api/ping`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok)
    .catch(() => false);
  lastCheck = { at: Date.now(), up };
  return up;
}

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>MailFlow is offline</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#f6f7f9;color:#1f2937;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:440px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 8px}p{margin:8px 0;line-height:1.5;color:#4b5563}
@media (prefers-color-scheme:dark){body{background:#111827;color:#f3f4f6}main{background:#1f2937;border-color:#374151}p{color:#d1d5db}}</style></head>
<body><main><h1>MailFlow is offline for a moment</h1><p>The MailFlow server is switched off or restarting. Nothing is lost: emails that were waiting will go out as soon as it is back.</p>
<p>This page checks again every minute.</p></main></body></html>`;

export async function middleware(req: NextRequest) {
  if (!UPSTREAM) return NextResponse.next();

  const isPageVisit = req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html');
  if (isPageVisit && !(await upstreamIsUp())) {
    return new NextResponse(OFFLINE_PAGE, {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60', 'cache-control': 'no-store' },
    });
  }
  return NextResponse.rewrite(new URL(req.nextUrl.pathname + req.nextUrl.search, UPSTREAM));
}

export const config = { matcher: '/:path*' };
