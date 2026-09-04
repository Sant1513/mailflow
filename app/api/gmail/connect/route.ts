import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { buildConsentUrl, OAUTH_STATE_COOKIE } from '@/lib/gmail/oauth';
import { audit } from '@/lib/audit/log';

/**
 * §29: starts the Gmail consent flow. Separate from login — signing in
 * grants identity only; this is where a user explicitly grants send access
 * to their own mailbox.
 */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  requireCanWrite(session.role);

  // CSRF: a random state, stored in an httpOnly cookie and verified on the
  // callback, so a third party cannot complete an OAuth flow on the user's
  // behalf.
  const state = crypto.randomBytes(24).toString('hex');
  cookies().set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });

  await audit(session, 'GMAIL_CONNECT_STARTED');

  return NextResponse.redirect(buildConsentUrl(state));
});
