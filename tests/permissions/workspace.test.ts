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
type AppSession = import('@/lib/auth/session').AppSession;

function session(overrides: Partial<{ role: Role; workspaceId: string | null; viewingAs: AppSession['viewingAs'] }> = {}): AppSession {
  return {
    userId: 'u1',
    organizationId: 'org1',
    workspaceId: 'ws-own',
    homeWorkspaceId: 'ws-own',
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
    expect(() => requireCanWrite(session({ role: Role.VIEWER }))).toThrow(ForbiddenError);
  });

  it('accepts a full session for writers', () => {
    expect(() => requireCanWrite(session({ role: Role.OPERATOR }))).not.toThrow();
    expect(() => requireCanWrite(session({ role: Role.SUPER_ADMIN }))).not.toThrow();
  });

  // §9: inspection is not impersonation.
  it('makes SUPER_ADMIN read-only while viewing another workspace', () => {
    const viewing = session({
      role: Role.SUPER_ADMIN,
      workspaceId: 'ws-other',
      viewingAs: { workspaceId: 'ws-other', workspaceName: 'Other', ownerName: 'R', ownerEmail: 'r@masaischool.com' },
    });
    expect(() => requireCanWrite(viewing)).toThrow(/Read-only while viewing/);
    // The bare-role overload cannot see the view-as flag, which is exactly
    // why every route now passes the session (see the Phase 6 sweep).
    expect(() => requireCanWrite(viewing.role)).not.toThrow();
  });
});

describe('resolveWorkspaceId while viewing as', () => {
  it('scopes to the viewed workspace without a DB lookup', async () => {
    vi.clearAllMocks();
    const viewing = session({
      role: Role.SUPER_ADMIN,
      workspaceId: 'ws-other',
      viewingAs: { workspaceId: 'ws-other', workspaceName: 'Other', ownerName: 'R', ownerEmail: 'r@masaischool.com' },
    });
    expect(await resolveWorkspaceId(viewing)).toBe('ws-other');
    expect(await resolveWorkspaceId(viewing, 'ws-other')).toBe('ws-other');
    expect(prisma.workspace.findFirst).not.toHaveBeenCalled();
  });
});
