import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/db/client';
import { Role } from '@prisma/client';

const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN ?? 'masaischool.com';

/**
 * Login-only Google OAuth (identity, not Gmail send/read access — see
 * lib/gmail/oauth.ts for the separate, incremental-consent Gmail connection
 * flow). §5 of the spec: only @masaischool.com may sign in.
 */
export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'database' },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      authorization: { params: { scope: 'openid email profile' } },
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
