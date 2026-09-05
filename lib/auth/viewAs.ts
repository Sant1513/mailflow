import crypto from 'node:crypto';

/**
 * §9 "View Workspace As" — a SUPER_ADMIN may inspect another user's
 * workspace. The selection lives in a signed, short-lived cookie so that
 * every request (pages and API alike) resolves the viewed workspace in ONE
 * place (requireSession) instead of trusting a `?workspaceId=` on each call.
 *
 * The cookie only carries a workspaceId; the server still checks on every
 * request that the workspace belongs to the admin's organization and that
 * the caller is still a SUPER_ADMIN. Losing the role invalidates the cookie
 * immediately, whatever it says.
 *
 * Signing uses the session secret, so a forged cookie fails verification
 * with the same secret that protects sessions themselves.
 */

export const VIEW_AS_COOKIE = 'mailflow.view-as';
/** 4 hours — long enough for an investigation, short enough to not linger. */
export const VIEW_AS_MAX_AGE_SECONDS = 4 * 60 * 60;

function secret(): string {
  const value = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!value) throw new Error('Missing session secret (NEXTAUTH_SECRET or AUTH_SECRET)');
  return value;
}

function sign(payload: string, key = secret()): string {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

/** Builds the cookie value: `<workspaceId>.<expiresMs>.<hmac>`. */
export function signViewAs(
  workspaceId: string,
  opts: { now?: number; maxAgeSeconds?: number; key?: string } = {}
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) throw new Error('Invalid workspace id');
  const now = opts.now ?? Date.now();
  const expires = now + (opts.maxAgeSeconds ?? VIEW_AS_MAX_AGE_SECONDS) * 1000;
  const payload = `${workspaceId}.${expires}`;
  return `${payload}.${sign(payload, opts.key)}`;
}

/**
 * Returns the workspaceId if the cookie is well-formed, unexpired and
 * carries a valid signature; null otherwise. Never throws on bad input —
 * a bad cookie simply means "not viewing as anyone".
 */
export function verifyViewAs(
  value: string | undefined | null,
  opts: { now?: number; key?: string } = {}
): string | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [workspaceId, expiresRaw, sig] = parts as [string, string, string];
  if (!workspaceId || !/^[A-Za-z0-9_-]+$/.test(workspaceId)) return null;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires <= (opts.now ?? Date.now())) return null;

  let expected: string;
  try {
    expected = sign(`${workspaceId}.${expiresRaw}`, opts.key);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return workspaceId;
}

export function viewAsCookieOptions(maxAge = VIEW_AS_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}
