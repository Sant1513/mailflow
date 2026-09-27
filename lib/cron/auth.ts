/** Cron endpoints accept `Authorization: Bearer $CRON_SECRET` (Vercel Cron, GitHub Actions) or `?secret=`. */
export function cronAuthorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}` || new URL(req.url).searchParams.get('secret') === secret;
}
