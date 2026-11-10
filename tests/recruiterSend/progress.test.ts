import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The open Recruiter Send page polls /progress every 15 s instead of the full send (email HTML,
 * preview, 200 recruiter rows, 24-hour usage per mailbox): small responses on the free tier. It
 * keeps the full GET's access rules.
 */
const db = {
  recruiterBlast: { findUnique: vi.fn() },
  recruiterBlastRecipient: { groupBy: vi.fn(), count: vi.fn() },
  recruiterBlastGroup: { groupBy: vi.fn(), findMany: vi.fn() },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@/lib/recruiterSend/worker', () => ({ nudgeStuckSends: vi.fn(async () => 0) }));
vi.mock('@/lib/campaigns/fallback', () => ({ availableFallbackMailboxes: vi.fn(), ownMailbox: vi.fn() }));

const session = { userId: 'u1', organizationId: 'o1', workspaceId: 'w1', role: 'ADMIN', viewingAs: null };
vi.mock('@/lib/auth/session', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...real, requireRole: vi.fn(async () => session) };
});

const { GET } = await import('@/app/api/recruiter-blasts/[id]/progress/route');
const get = (id = 'b1') => GET(new Request(`http://localhost/api/recruiter-blasts/${id}/progress`) as any, { params: { id } } as any);

beforeEach(() => {
  vi.clearAllMocks();
  db.recruiterBlast.findUnique.mockResolvedValue({ id: 'b1', organizationId: 'o1', workspaceId: 'w1', status: 'SENDING', scheduledAt: null, startedAt: new Date('2026-11-10T10:00:00Z'), completedAt: null, updatedAt: new Date() });
  db.recruiterBlastRecipient.groupBy.mockResolvedValue([{ status: 'SENT', _count: { _all: 3 } }, { status: 'QUEUED', _count: { _all: 2 } }]);
  db.recruiterBlastRecipient.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2); // replied, opened
  db.recruiterBlastGroup.groupBy.mockResolvedValue([{ status: 'SENT', _count: { _all: 3 }, _sum: { openCount: 4 } }, { status: 'QUEUED', _count: { _all: 2 }, _sum: { openCount: 0 } }]);
  db.recruiterBlastGroup.findMany.mockResolvedValue([
    { id: 'g1', seq: 1, status: 'SENT', recipientCount: 1, fromEmail: 'a@masaischool.com', sentAt: null, openCount: 1, firstOpenedAt: null, lastOpenedAt: null, error: null },
    { id: 'g2', seq: 2, status: 'SENT', recipientCount: 1, fromEmail: 'b@masaischool.com', sentAt: null, openCount: 0, firstOpenedAt: null, lastOpenedAt: null, error: null },
    { id: 'g3', seq: 3, status: 'SENT', recipientCount: 1, fromEmail: 'a@masaischool.com', sentAt: null, openCount: 3, firstOpenedAt: null, lastOpenedAt: null, error: null },
    { id: 'g4', seq: 4, status: 'QUEUED', recipientCount: 1, fromEmail: 'b@masaischool.com', sentAt: null, openCount: 0, firstOpenedAt: null, lastOpenedAt: null, error: null },
  ]);
});

describe('GET /api/recruiter-blasts/[id]/progress', () => {
  it('returns status, counts, totals, slim groups and sends per mailbox, without the email or recruiter rows', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.blast).toMatchObject({ id: 'b1', status: 'SENDING' });
    expect(Object.keys(j.blast).sort()).toEqual(['completedAt', 'id', 'scheduledAt', 'startedAt', 'status', 'updatedAt']);
    expect(j.counts).toEqual({ total: 5, SENT: 3, QUEUED: 2, REPLIED: 1 });
    expect(j.stats).toEqual({ messagesSent: 3, messagesTotal: 5, opens: 4, openedRecruiters: 2 });
    expect(j.groups).toHaveLength(4);
    expect(j.sentByMailbox).toEqual({ 'a@masaischool.com': 2, 'b@masaischool.com': 1 });
    expect(j).not.toHaveProperty('recipients');
    expect(j).not.toHaveProperty('previewHtml');
    // Only status columns are read from the send itself (not its HTML or body).
    expect(db.recruiterBlast.findUnique.mock.calls[0]![0]).toHaveProperty('select');
  });

  it('404s for a send that does not exist', async () => {
    db.recruiterBlast.findUnique.mockResolvedValue(null);
    expect((await get('missing')).status).toBe(404);
  });

  it("refuses another workspace's send to an ADMIN", async () => {
    db.recruiterBlast.findUnique.mockResolvedValue({ id: 'b1', organizationId: 'o1', workspaceId: 'other', status: 'SENDING' });
    expect((await get()).status).toBe(403);
  });

  it("refuses another organisation's send", async () => {
    db.recruiterBlast.findUnique.mockResolvedValue({ id: 'b1', organizationId: 'o2', workspaceId: 'w1', status: 'SENDING' });
    expect((await get()).status).toBe(403);
  });
});
