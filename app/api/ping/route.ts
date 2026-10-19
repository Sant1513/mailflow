// Liveness check with no database access. The Vercel front door calls it to see whether
// the laptop server is reachable before forwarding a page (middleware.ts).
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ ok: true, at: new Date().toISOString() }, { headers: { 'cache-control': 'no-store' } });
}
