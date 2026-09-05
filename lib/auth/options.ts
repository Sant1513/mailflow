import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/db/client';
import { Role } from '@prisma/client';

/**
 * Optional sign-up allowlist.
 *
 * When ALLOWED_EMAIL_DOMAIN is set (e.g. "masaischool.com"), only that
 * domain may sign in. When it is unset or empty, ANY Google account may
 * sign in — which is what open signup means: anyone who finds the URL can
 * create a workspace and send mail from their own Gmail.
 *
 * The mechanism is kept rather than deleted so the restriction can be
 * restored with one env var before real student data is loaded.
 */
export function allowedDomain(): string | null {
  const configured = process.env.ALLOWED_EMAIL_DOMAIN?.trim();
  return configured ? configured.toLowerCase() : null;
}

export function isEmailAllowed(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase() ?? '';
  // An address is still required — open signup is not "no identity".
  if (!normalized || !normalized.includes('@')) return false;

  const restriction = allowedDomain();
  if (!restriction) return true;

  // Compare the full domain, never a suffix: "masaischool.com.evil.com"
  // must not pass a check for "masaischool.com".
  return normalized.split('@')[1] === restriction;
}

/**
 * Resolves the session-signing secret, accepting either the NextAuth v4
 * name (NEXTAUTH_SECRET) or the Auth.js v5 name (AUTH_SECRET).
 *
 * Fails loudly at startup in production instead of letting NextAuth throw
 * an opaque NO_SECRET error on the first request — a missing secret is a
 * deployment mistake, and it should read like one.
 */
function authSecret(): string | undefined {
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error(
      'Missing session secret: set NEXTAUTH_SECRET (or AUTH_SECRET) in the environment. Generate one with `openssl rand -base64 32`.'
    );
  }
  return secret;
}

/**
 * Organization.allowedDomain is a unique column, so open signup still needs
 * a stable key for the single shared organization. "*" reads as "any
 * domain" and cannot collide with a real domain.
 */
const OPEN_SIGNUP_ORG_KEY = '*';

/**
 * Resolves the organization a signing-in user belongs to.
 *
 * With a domain restriction, the organization is keyed by that domain. With
 * open signup, everyone shares one organization — and crucially it reuses
 * whichever organization already exists, so lifting the restriction does
 * not strand existing users and their workspaces in a separate tenant from
 * everyone who signs up afterwards.
 */
async function resolveOrganization() {
  const restriction = allowedDomain();
  if (restriction) {
    return prisma.organization.upsert({
      where: { allowedDomain: restriction },
      update: {},
      create: { name: 'Masai School', allowedDomain: restriction },
    });
  }

  const existing = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) return existing;

  return prisma.organization.create({
    data: { name: 'MailFlow', allowedDomain: OPEN_SIGNUP_ORG_KEY },
  });
}

/**
 * Login-only Google OAuth (identity, not Gmail send/read access — see
 * lib/gmail/oauth.ts for the separate, incremental-consent Gmail connection
 * flow).
 *
 * Sign-up is open by default; set ALLOWED_EMAIL_DOMAIN to restrict it back
 * to a single domain (see isEmailAllowed above).
 */
export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'database' },
  // Set explicitly rather than relying on NextAuth picking up an env var by
  // name. NextAuth v4 only auto-reads NEXTAUTH_SECRET; AUTH_SECRET is the
  // Auth.js v5 name. Accepting both means a deployment configured with
  // either name works, instead of failing at runtime with NO_SECRET — which
  // is invisible in development, because a secret is only *required* in
  // production.
  secret: authSecret(),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      authorization: { params: { scope: 'openid email profile' } },
      // Before redirecting to Google, NextAuth fetches Google's OpenID
      // discovery document server-side. openid-client caps that at 3500ms,
      // which is too tight: a cold Next.js route compile stalls the event
      // loop long enough to blow the budget even on a fast connection
      // (measured ~150ms to accounts.google.com from this machine). The
      // timeout surfaced as ?error=OAuthSignin — a Sign in button that
      // simply did nothing. 10s tolerates the stall without hanging a user
      // on a genuinely unreachable network.
      httpOptions: { timeout: 10_000 },
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: profile.picture,
        };
      },
    }),
  ],
  pages: {
    error: '/login/error',
  },
  callbacks: {
    async signIn({ user, account }) {
      const email = user.email?.toLowerCase() ?? '';
      if (!isEmailAllowed(email)) {
        // Rejected — NextAuth redirects to /login/error?error=AccessDenied
        return false;
      }

      // Ensure the Organization exists, and every accepted user gets an
      // Organization + personal Workspace on first sign-in.
      const org = await resolveOrganization();

      const existing = await prisma.user.findUnique({ where: { email } });
      if (!existing) {
        const created = await prisma.user.create({
          data: {
            organizationId: org.id,
            googleId: account?.providerAccountId ?? user.id,
            email,
            name: user.name ?? email,
            profileImage: user.image ?? undefined,
            role: Role.OPERATOR,
          },
        });
        await prisma.workspace.create({
          data: {
            organizationId: org.id,
            ownerId: created.id,
            name: `${created.name}'s Workspace`,
            members: { create: { userId: created.id, role: Role.OPERATOR } },
          },
        });
      } else {
        if (existing.status === 'DISABLED') return false;
        await prisma.user.update({
          where: { id: existing.id },
          data: { lastLoginAt: new Date() },
        });
      }

      return true;
    },
    async session({ session, user }) {
      const dbUser = await prisma.user.findUnique({
        where: { email: session.user?.email ?? '' },
        include: { ownedWorkspaces: true },
      });
      if (dbUser && session.user) {
        (session.user as any).id = dbUser.id;
        (session.user as any).role = dbUser.role;
        (session.user as any).organizationId = dbUser.organizationId;
        (session.user as any).workspaceId = dbUser.ownedWorkspaces[0]?.id ?? null;
      }
      return session;
    },
  },
};
