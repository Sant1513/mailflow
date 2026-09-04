import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { prisma } from '@/lib/db/client';
import { encryptSecret, decryptSecret } from '@/lib/crypto/secretBox';
import type { EmailProviderAccount } from '@prisma/client';

/**
 * §29 Gmail OAuth — deliberately separate from login.
 *
 * Signing in with Google grants identity only (openid/email/profile).
 * Sending mail requires an additional, explicit consent step so a user is
 * never silently granting mailbox access just by logging in. Tokens are
 * encrypted at rest and never leave the server (§10/§97).
 */

/**
 * Name of the httpOnly cookie holding the OAuth CSRF state. Defined here
 * rather than in the route, because Next.js route files may only export
 * HTTP handlers.
 */
export const OAUTH_STATE_COOKIE = 'mailflow_gmail_oauth_state';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  // Needed to read back sent messages (for threading metadata) and to sync
  // inbound replies in Phase 5. Narrower than full mail access.
  'https://www.googleapis.com/auth/gmail.readonly',
];

export function gmailRedirectUri(): string {
  const base = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/gmail/callback`;
}

export function createOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured.');
  }
  return new google.auth.OAuth2(clientId, clientSecret, gmailRedirectUri());
}

export function buildConsentUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline', // we need a refresh token for background sending
    prompt: 'consent', // force a refresh token even on re-connect
    scope: GMAIL_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

/**
 * Returns an OAuth client authorized as the given account, refreshing the
 * access token when it is expired or about to expire, and persisting the
 * (re-encrypted) result.
 */
export async function authorizedClientFor(account: EmailProviderAccount): Promise<OAuth2Client> {
  const client = createOAuthClient();

  if (!account.refreshTokenEnc) {
    throw new Error(`Gmail account ${account.emailAddress} has no refresh token — reconnect required.`);
  }

  client.setCredentials({
    access_token: account.accessTokenEnc ? decryptSecret(account.accessTokenEnc) : undefined,
    refresh_token: decryptSecret(account.refreshTokenEnc),
    expiry_date: account.tokenExpiresAt?.getTime(),
  });

  // Refresh a minute early rather than waiting for a 401 mid-send.
  const expiresSoon = !account.tokenExpiresAt || account.tokenExpiresAt.getTime() - Date.now() < 60_000;
  if (expiresSoon) {
    const { credentials } = await client.refreshAccessToken();
    await prisma.emailProviderAccount.update({
      where: { id: account.id },
      data: {
        accessTokenEnc: credentials.access_token ? encryptSecret(credentials.access_token) : account.accessTokenEnc,
        // Google only returns a refresh_token on first consent; keep the
        // existing one when it isn't re-issued.
        refreshTokenEnc: credentials.refresh_token ? encryptSecret(credentials.refresh_token) : account.refreshTokenEnc,
        tokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
        status: 'CONNECTED',
        lastVerifiedAt: new Date(),
      },
    });
    client.setCredentials(credentials);
  }

  return client;
}

/**
 * Marks an account as needing reconnection. Called when Google rejects our
 * credentials so the UI can prompt instead of silently failing every send.
 */
export async function markAccountExpired(accountId: string, reason: string): Promise<void> {
  await prisma.emailProviderAccount.update({
    where: { id: accountId },
    data: { status: 'EXPIRED', lastVerifiedAt: new Date() },
  }).catch(() => {
    /* account may have been deleted; nothing to mark */
  });
  console.error('[gmail] account marked EXPIRED', { accountId, reason });
}
