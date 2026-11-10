import { timingSafeEqual } from 'node:crypto';

/**
 * Cron endpoints accept only `Authorization: Bearer $CRON_SECRET` (Vercel Cron, GitHub Actions,
 * the laptop server, the app's own self-calls). Never `?secret=` in the URL: URLs end up in
 * request logs and browser history, and the same secret also signs archive links.
 */
export function cronAuthorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  return bearerMatches(req.headers.get('authorization'), secret);
}

/** Constant-time comparison of an Authorization header with `Bearer <secret>`. */
export function bearerMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
