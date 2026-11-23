import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Moving a running Recruiter Bulk Send between the cloud and the laptop (control route: to_laptop / to_cloud).
 * To the laptop only while the laptop is online and MailFlow is not already running there; both ways only for a send
 * that is still to go out and currently on the other side.
 */
const db = { recruiterBlast: { updateMany: vi.fn(async (_q: any): Promise<{ count: number }> => ({ count: 1 })) } };
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const access = { requireBlastAdmin: vi.fn(async () => ({ organizationId: 'o1', workspaceId: 'w1' })), loadBlast: vi.fn(async (): Promise<any> => ({ id: 'b1', status: 'SENDING', runOn: 'cloud' })) };
vi.mock('@/lib/recruiterSend/access', () => access);
vi.mock('@/lib/audit/log', () => ({ audit: vi.fn(async () => undefined) }));
const kick = vi.fn();
vi.mock('@/lib/recruiterSend/worker', () => ({ kickRecruiterWorker: kick }));
const state = { activeServer: 'cloud', lastLaptopSeenAt: new Date() as Date | null };
vi.mock('@/lib/system/serverState', async (orig) => ({ ...(await orig<any>()), currentState: vi.fn(async () => state) }));

const { POST } = await import('@/app/api/recruiter-blasts/[id]/control/route');
const call = (action: string) => POST(new Request('http://x/api/recruiter-blasts/b1/control', { method: 'POST', body: JSON.stringify({ action }) }), { params: { id: 'b1' } });

beforeEach(() => {
  vi.clearAllMocks();
  state.activeServer = 'cloud';
  state.lastLaptopSeenAt = new Date();
  db.recruiterBlast.updateMany.mockResolvedValue({ count: 1 });
});

describe('move to the laptop', () => {
  it('flips runOn for a send still to go out that is on the cloud, clearing the "moved" note', async () => {
    const res = await call('to_laptop');
    expect(res.status).toBe(200);
    const q = db.recruiterBlast.updateMany.mock.calls[0]![0];
    expect(q.where).toMatchObject({ id: 'b1', runOn: 'cloud', status: { in: ['SENDING', 'SCHEDULED', 'PAUSED'] } });
    expect(q.data).toEqual({ runOn: 'laptop', runOnChangedAt: null });
  });

  it('is refused while the laptop is offline', async () => {
    state.lastLaptopSeenAt = new Date(Date.now() - 10 * 60_000);
    expect((await call('to_laptop')).status).toBe(409);
    expect(db.recruiterBlast.updateMany).not.toHaveBeenCalled();
  });

  it('is refused when MailFlow already runs on the laptop', async () => {
    state.activeServer = 'laptop';
    expect((await call('to_laptop')).status).toBe(409);
  });

  it('is refused for a send that is not running or already there', async () => {
    db.recruiterBlast.updateMany.mockResolvedValue({ count: 0 });
    expect((await call('to_laptop')).status).toBe(409);
  });
});

describe('move to the cloud', () => {
  it('flips runOn back and nudges the cloud sender for a running send', async () => {
    const res = await call('to_cloud');
    expect(res.status).toBe(200);
    expect(db.recruiterBlast.updateMany.mock.calls[0]![0].data).toEqual({ runOn: 'cloud', runOnChangedAt: null });
    expect(kick).toHaveBeenCalledWith('resume');
  });

  it('does not nudge a paused send', async () => {
    access.loadBlast.mockResolvedValueOnce({ id: 'b1', status: 'PAUSED', runOn: 'laptop' });
    await call('to_cloud');
    expect(kick).not.toHaveBeenCalled();
  });

  it('is refused when the send is not on the laptop', async () => {
    db.recruiterBlast.updateMany.mockResolvedValue({ count: 0 });
    expect((await call('to_cloud')).status).toBe(409);
  });
});
