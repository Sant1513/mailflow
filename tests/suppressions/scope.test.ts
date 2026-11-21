import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One suppression list per organisation for bounces and spam complaints (lib/suppressions/scope.ts):
 * a bounce saved in ANY workspace of the organisation blocks the address for every workspace; an unsubscribe
 * only for the workspace it belongs to.
 */
const db = {
  workspace: {
    findUnique: vi.fn(async (_q: any): Promise<any> => ({ organizationId: 'org1' })),
    findMany: vi.fn(async (_q: any): Promise<any> => [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]),
  },
  emailSuppression: { findMany: vi.fn(async (_q: any): Promise<any[]> => []) },
  $queryRaw: vi.fn(async (): Promise<any[]> => []),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const scope = await import('@/lib/suppressions/scope');
const { suppressionRows, suppressedKeys } = await import('@/lib/email/suppressedKeys');

beforeEach(() => {
  vi.clearAllMocks();
  scope.resetOrgScopeCache();
  db.workspace.findUnique.mockResolvedValue({ organizationId: 'org1' });
  db.workspace.findMany.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
});

describe('what a workspace sees', () => {
  it('its own entries, plus every bounce and complaint saved anywhere in the organisation', async () => {
    const w = await scope.visibleToWorkspace('w2');
    expect(w).toEqual({ OR: [{ workspaceId: 'w2' }, { workspaceId: { in: expect.arrayContaining(['w1', 'w2', 'w3']) }, reason: { in: ['BOUNCED', 'COMPLAINT'] } }] });
  });

  it('a workspace alone in its organisation sees only its own', async () => {
    db.workspace.findMany.mockResolvedValue([{ id: 'w9' }]);
    expect(await scope.visibleToWorkspace('w9')).toEqual({ workspaceId: 'w9' });
  });

  it('if the organisation cannot be looked up it falls back to its own entries, and tries again next time', async () => {
    db.workspace.findUnique.mockRejectedValueOnce(new Error('db hiccup'));
    expect(await scope.visibleToWorkspace('w1')).toEqual({ workspaceId: 'w1' });
    expect(await scope.visibleToWorkspace('w1')).toMatchObject({ OR: expect.any(Array) });
  });

  it('the organisation is looked up once, then remembered', async () => {
    await scope.visibleToWorkspace('w1');
    await scope.visibleToWorkspace('w1');
    expect(db.workspace.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('checks use the shared list', () => {
  it('suppressionRows looks for the addresses across the organisation, not only the workspace', async () => {
    db.emailSuppression.findMany.mockResolvedValue([{ email: 'gone@corp.com', reason: 'BOUNCED', detail: 'no such user' }]);
    const rows = await suppressionRows('w3', ['Gone@Corp.com', 'fine@corp.com']);
    expect(rows).toEqual([{ email: 'gone@corp.com', reason: 'BOUNCED', detail: 'no such user' }]);
    const where = (db.emailSuppression.findMany.mock.calls[0] as any[])[0].where;
    expect(where.OR).toBeDefined();
    expect(where.email).toEqual({ in: ['gone@corp.com', 'fine@corp.com'] });
  });

  it('a bounce saved by a teammate blocks a follow-up in another workspace, under any Gmail spelling', async () => {
    // The raw lookups (exact lower-case and Gmail key) find the teammate's row.
    db.$queryRaw.mockResolvedValue([{ email: 'Ab.C@gmail.com' }]);
    const keys = await suppressedKeys('w3', ['abc+news@gmail.com']);
    expect(keys.has('abc@gmail.com')).toBe(true);
  });
});
