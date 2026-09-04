import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Role } from '@prisma/client';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    workspace: { findFirst: vi.fn() },
  },
}));

const { prisma } = await import('@/lib/db/client');
const { resolveWorkspaceId, canWrite, requireCanWrite } = await import(
  '@/lib/permissions/workspace'
);
const { ForbiddenError } = await import('@/lib/auth/session');

function session(overrides: Partial<{ role: Role; workspaceId: string | null }> = {}) {
  return {
    userId: 'u1',
    organizationId: 'org1',
    workspaceId: 'ws-own',
    role: Role.OPERATOR,
    email: 'a@masaischool.com',
    name: 'A',
    ...overrides,
  };
}

describe('resolveWorkspaceId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the caller\'s own workspace when none is requested', async () => {
    const id = await resolveWorkspaceId(session());
    expect(id).toBe('ws-own');
  });

  it('returns the caller\'s own workspace when the requested one matches', async () => {
    const id = await resolveWorkspaceId(session(), 'ws-own');
    expect(id).toBe('ws-own');
  });

  it('rejects a non-super-admin requesting another workspace', async () => {
    await expect(resolveWorkspaceId(session(), 'ws-other')).rejects.toThrow(ForbiddenError);
  });

  it('rejects when the session has no workspace at all', async () => {
    await expect(resolveWorkspaceId(session({ workspaceId: null }))).rejects.toThrow(ForbiddenError);
  });

  it('allows SUPER_ADMIN to view another workspace in the same org', async () => {
    (prisma.workspace.findFirst as any).mockResolvedValue({ id: 'ws-other' });
    const id = await resolveWorkspaceId(session({ role: Role.SUPER_ADMIN }), 'ws-other');
    expect(id).toBe('ws-other');
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: 'ws-other', organizationId: 'org1' },
    });
  });

  it('rejects SUPER_ADMIN requesting a workspace outside their org', async () => {
    (prisma.workspace.findFirst as any).mockResolvedValue(null);
    await expect(
      resolveWorkspaceId(session({ role: Role.SUPER_ADMIN }), 'ws-foreign')
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('canWrite / requireCanWrite', () => {
  it('allows SUPER_ADMIN, ADMIN, OPERATOR', () => {
    expect(canWrite(Role.SUPER_ADMIN)).toBe(true);
    expect(canWrite(Role.ADMIN)).toBe(true);
    expect(canWrite(Role.OPERATOR)).toBe(true);
  });

  it('denies VIEWER', () => {
    expect(canWrite(Role.VIEWER)).toBe(false);
    expect(() => requireCanWrite(Role.VIEWER)).toThrow(ForbiddenError);
  });
});
