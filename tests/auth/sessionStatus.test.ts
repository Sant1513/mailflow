import { beforeEach, describe, expect, it, vi } from 'vitest';

// A pending or disabled user still has a NextAuth session; the API must not accept it.
const state: { user: Record<string, unknown> | null } = { user: null };
vi.mock('next-auth', () => ({ getServerSession: async () => (state.user ? { user: state.user } : null) }));
vi.mock('next/headers', () => ({ cookies: () => ({ get: () => undefined }) }));
vi.mock('@/lib/auth/options', () => ({ authOptions: {} }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));

const { requireSession, getOptionalSession, UnauthorizedError, ForbiddenError } = await import('@/lib/auth/session');

const user = (status: string) => ({ id: 'u1', organizationId: 'o1', workspaceId: 'w1', role: 'OPERATOR', status, email: 'a@masaischool.com', name: 'A' });

describe('session status gate', () => {
  beforeEach(() => {
    state.user = null;
  });

  it('lets an ACTIVE user through', async () => {
    state.user = user('ACTIVE');
    await expect(requireSession()).resolves.toMatchObject({ userId: 'u1', status: 'ACTIVE' });
  });

  it('refuses a PENDING user on every API (403) but still shows them the pending page', async () => {
    state.user = user('PENDING');
    await expect(requireSession()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOptionalSession()).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('treats a DISABLED user as signed out everywhere', async () => {
    state.user = user('DISABLED');
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(getOptionalSession()).resolves.toBeNull();
  });

  it('refuses when there is no session', async () => {
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
