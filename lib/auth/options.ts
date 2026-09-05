import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/db/client';
import { Role } from '@prisma/client';

const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN ?? 'masaischool.com';

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
 * Login-only Google OAuth (identity, not Gmail send/read access — see
 * lib/gmail/oauth.ts for the separate, incremental-consent Gmail connection
 * flow). §5 of the spec: only @masaischool.com may sign in.
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
      const domain = email.split('@')[1];
      if (domain !== ALLOWED_DOMAIN) {
        // Rejected — NextAuth redirects to /login/error?error=AccessDenied
        return false;
      }

      // Ensure the Organization exists, and every allowed-domain user gets
      // an Organization + personal Workspace on first sign-in.
      const org = await prisma.organization.upsert({
        where: { allowedDomain: ALLOWED_DOMAIN },
        update: {},
        create: { name: 'Masai School', allowedDomain: ALLOWED_DOMAIN },
      });

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
