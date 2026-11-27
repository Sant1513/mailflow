import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tidyEmailHtml, splitMessageBody } from '@/lib/conversations/messageView';

describe('tidyEmailHtml', () => {
  it('removes Outlook empty first block, lone <br> and the appendonsend marker, keeps the words', () => {
    const html = '<html><head></head><body dir="ltr"><div class="elementToProof"><br></div><div id="appendonsend"></div><div style="margin-top:1em">Hi Mannan,</div><div>Thanks.</div><div><br></div></body></html>';
    const out = tidyEmailHtml(html);
    expect(out).toContain('<body dir="ltr"><div style="margin-top:1em">Hi Mannan,</div><div>Thanks.</div></body>');
  });
  it('squeezes runs of line breaks and leaves ordinary mail alone', () => {
    expect(tidyEmailHtml('<p>a</p><br><br><br><br><p>b</p>')).toBe('<p>a</p><br><br><p>b</p>');
    expect(tidyEmailHtml('<p>one</p><p>two</p>')).toBe('<p>one</p><p>two</p>');
  });
  it('is fast on a big message full of blocks', () => {
    const big = '<div>x</div>'.repeat(5000) + '<div><br></div>'.repeat(300);
    const t = Date.now();
    tidyEmailHtml(big);
    expect(Date.now() - t).toBeLessThan(500);
  });
  it('splitMessageBody uses it', () => {
    expect(splitMessageBody({ htmlBody: '<div><br></div><p>Hello</p>' }).main).toBe('<p>Hello</p>');
  });
});

const db = { workspace: { findUnique: vi.fn() }, inboxShare: { findMany: vi.fn(async (): Promise<any[]> => []) } };
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const { decideAccess, accessFor, teamScope } = await import('@/lib/conversations/access');

const conv = { workspaceId: 'w-other', ownerId: 'u-owner', assigneeId: null as string | null };
const admin: any = { workspaceId: 'w-me', userId: 'u-me', organizationId: 'o1', role: 'ADMIN', orgUnitId: 'ou1' };

describe('team replies: who sees which conversations', () => {
  beforeEach(() => vi.clearAllMocks());
  it('scope: a Super Admin sees the company, an Admin their organisation, others nothing', () => {
    expect(teamScope({ organizationId: 'o1', role: 'SUPER_ADMIN', orgUnitId: null })).toEqual({ organizationId: 'o1' });
    expect(teamScope({ organizationId: 'o1', role: 'ADMIN', orgUnitId: 'ou1' })).toEqual({ organizationId: 'o1', workspace: { orgUnitId: 'ou1' } });
    expect(teamScope({ organizationId: 'o1', role: 'ADMIN', orgUnitId: null })).toBeNull();
    expect(teamScope({ organizationId: 'o1', role: 'OPERATOR', orgUnitId: 'ou1' })).toBeNull();
  });
  it('an Admin of the same organisation may work (not reply from) a colleague\'s conversation', async () => {
    expect(decideAccess(admin, conv, [], true)).toBe('WORK');
    db.workspace.findUnique.mockResolvedValue({ orgUnitId: 'ou1', organizationId: 'o1' });
    expect(await accessFor(admin, conv)).toBe('WORK');
  });
  it('an Admin of another organisation gets nothing', async () => {
    db.workspace.findUnique.mockResolvedValue({ orgUnitId: 'ou2', organizationId: 'o1' });
    expect(await accessFor(admin, conv)).toBeNull();
  });
  it('an operator never gets it, and a Super Admin has full access', async () => {
    expect(await accessFor({ ...admin, role: 'OPERATOR' }, conv)).toBeNull();
    expect(await accessFor({ ...admin, role: 'SUPER_ADMIN' }, conv)).toBe('FULL');
    expect(db.workspace.findUnique).not.toHaveBeenCalled();
  });
});
