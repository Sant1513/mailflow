import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { google } from 'googleapis';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { createOAuthClient, GMAIL_SCOPES, OAUTH_STATE_COOKIE } from '@/lib/gmail/oauth';
import { encryptSecret } from '@/lib/crypto/secretBox';
import { audit } from '@/lib/audit/log';
import { EmailProvider as EmailProviderEnum } from '@prisma/client';

function settingsRedirect(message: string, ok: boolean) {
  const base = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const url = new URL('/settings', base);
  url.searchParams.set(ok ? 'gmail' : 'gmailError', message);
  return NextResponse.redirect(url);
}

/** §29: exchanges the consent code for tokens and stores them encrypted. */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);

  const error = url.searchParams.get('error');
  if (error) return settingsRedirect(`Google returned: ${error}`, false);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = cookies().get(OAUTH_STATE_COOKIE)?.value;

  // Verify CSRF state before doing anything with the code.
  if (!state || !expectedState || state !== expectedState) {
    throw new ForbiddenError('OAuth state mismatch — please start the connection again.');
  }
  cookies().delete(OAUTH_STATE_COOKIE);

  if (!code) return settingsRedirect('No authorization code returned.', false);

  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) return settingsRedirect('Google did not return an access token.', false);
  if (!tokens.refresh_token) {
    // Without a refresh token we cannot send in the background later.
    return settingsRedirect(
      'Google did not return a refresh token. Remove MailFlow at myaccount.google.com/permissions, then connect again.',
      false
    );
  }

  // Confirm the granted scopes actually include what we need, rather than
  // discovering a missing scope at send time.
  const granted = (tokens.scope ?? '').split(' ');
  const missing = GMAIL_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) {
    return settingsRedirect(`Missing required permission(s): ${missing.join(', ')}`, false);
  }

  // Identify the mailbox we were actually granted access to.
  client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  let emailAddress = '';
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    emailAddress = profile.data.emailAddress ?? '';
  } catch (err) {
    // This is the first Gmail API call in the whole flow, so it is where a
    // Google Cloud project misconfiguration surfaces. The consent itself
    // succeeded; the tokens are simply not usable yet. Send the user back
    // to Settings with the exact fix instead of a raw JSON 500 — an
    // operator saw that raw page and could not tell whether consent had
    // worked at all.
    const message = (err as Error).message ?? String(err);
    const projectMatch = message.match(/project\s+(\d+)/);
    if (/has not been used in project|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(message)) {
      const project = projectMatch?.[1];
      const enableUrl = project
        ? `https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=${project}`
        : 'https://console.cloud.google.com/apis/library/gmail.googleapis.com';
      return settingsRedirect(
        `Consent succeeded, but the Gmail API is not enabled in your Google Cloud project. Enable it at ${enableUrl}, wait a minute, then click Connect Gmail again.`,
        false
      );
    }
    console.error('[gmail] getProfile failed after consent', message);
    return settingsRedirect(`Google accepted the connection but the mailbox could not be read: ${message}`, false);
  }

  // §28: the connected mailbox must be the signed-in user's own account.
  // Connecting somebody else's mailbox — even with their consent screen —
  // would let campaigns send under a mismatched identity.
  if (emailAddress.toLowerCase() !== session.email.toLowerCase()) {
    return settingsRedirect(
      `You authorized ${emailAddress}, but you are signed in as ${session.email}. Connect the mailbox that matches your MailFlow account.`,
      false
    );
  }

  if (!session.workspaceId) throw new ForbiddenError('No workspace on session');

  await prisma.emailProviderAccount.upsert({
    where: {
      workspaceId_userId_provider: {
        workspaceId: session.workspaceId,
        userId: session.userId,
        provider: EmailProviderEnum.GMAIL,
      },
    },
    update: {
      emailAddress,
      displayName: session.name,
      accessTokenEnc: encryptSecret(tokens.access_token),
      refreshTokenEnc: encryptSecret(tokens.refresh_token),
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: tokens.scope,
      status: 'CONNECTED',
      lastVerifiedAt: new Date(),
    },
    create: {
      organizationId: session.organizationId,
      workspaceId: session.workspaceId,
      userId: session.userId,
      provider: EmailProviderEnum.GMAIL,
      emailAddress,
      displayName: session.name,
      accessTokenEnc: encryptSecret(tokens.access_token),
      refreshTokenEnc: encryptSecret(tokens.refresh_token),
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: tokens.scope,
      status: 'CONNECTED',
      lastVerifiedAt: new Date(),
    },
  });

  await audit(session, 'GMAIL_CONNECTED', { targetType: 'EmailProviderAccount', metadata: { emailAddress } });

  return settingsRedirect(`connected:${emailAddress}`, true);
});
