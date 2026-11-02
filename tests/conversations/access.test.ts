import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
const { decideAccess, atLeast } = await import('@/lib/conversations/access');

const me = { workspaceId: 'ws-me', userId: 'u-me', role: 'OPERATOR' as any };
const other = { workspaceId: 'ws-asha', ownerId: 'u-asha', assigneeId: null as string | null };

describe('conversation access', () => {
  it('own workspace and super admins get full access', () => {
    expect(decideAccess(me, { ...other, workspaceId: 'ws-me' }, [])).toBe('FULL');
    expect(decideAccess({ ...me, role: 'SUPER_ADMIN' }, other, [])).toBe('FULL');
  });

  it("someone else's conversation is closed unless shared or assigned", () => {
    expect(decideAccess(me, other, [])).toBeNull();
  });

  it('the assignee can work it (fixes: assigned but could not open)', () => {
    expect(decideAccess(me, { ...other, assigneeId: 'u-me' }, [])).toBe('WORK');
  });

  it('a share gives view or reply; the highest grant wins', () => {
    expect(decideAccess(me, other, ['VIEW'])).toBe('VIEW');
    expect(decideAccess(me, other, ['REPLY'])).toBe('REPLY');
    expect(decideAccess(me, other, ['VIEW', 'REPLY'])).toBe('REPLY');
    // Assigned + view-only share: still able to work it.
    expect(decideAccess(me, { ...other, assigneeId: 'u-me' }, ['VIEW'])).toBe('WORK');
    // Assigned + reply share: may answer from the owner's mailbox.
    expect(decideAccess(me, { ...other, assigneeId: 'u-me' }, ['REPLY'])).toBe('REPLY');
  });

  it('orders the levels', () => {
    expect(atLeast('REPLY', 'WORK')).toBe(true);
    expect(atLeast('WORK', 'REPLY')).toBe(false);
    expect(atLeast('VIEW', 'WORK')).toBe(false);
    expect(atLeast(null, 'VIEW')).toBe(false);
  });
});
