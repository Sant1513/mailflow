import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  integrationSettings: { findUnique: vi.fn() },
  recruiterBlast: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'b1', ...data })) },
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/audit/log', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/recruiterSend/access', () => ({
  requireBlastAdmin: vi.fn(async () => ({ userId: 'u1', organizationId: 'o1', workspaceId: 'w1', role: 'ADMIN', name: 'A' })),
  requireBlastReader: vi.fn(),
  sendableMailboxes: vi.fn(async () => [{ id: 'a1', own: true }]),
}));
vi.mock('@/lib/recruiterSend/worker', () => ({ nudgeStuckSends: vi.fn() }));

import { getRecruiterRepeatDays, parseOrgSettings, orgSettingsSchema } from '@/lib/settings/org';
const { POST } = await import('@/app/api/recruiter-blasts/route');

beforeEach(() => {
  db.integrationSettings.findUnique.mockReset();
  db.recruiterBlast.create.mockClear();
});

describe('recruiter repeat window setting', () => {
  it('defaults to 10 for empty and old rows', () => {
    expect(parseOrgSettings(null).recruiter.repeatWindowDays).toBe(10);
    expect(parseOrgSettings({ digest: { enabled: false } }).recruiter.repeatWindowDays).toBe(10);
    expect(parseOrgSettings({ recruiter: {} }).recruiter.repeatWindowDays).toBe(10);
  });

  it('accepts 0..90 integers and rejects the rest', () => {
    for (const v of [0, 1, 6, 90]) expect(orgSettingsSchema.parse({ recruiter: { repeatWindowDays: v } }).recruiter.repeatWindowDays).toBe(v);
    for (const v of [-1, 91, 2.5, '7']) expect(orgSettingsSchema.safeParse({ recruiter: { repeatWindowDays: v } }).success).toBe(false);
  });

  it('falls back to 10 when the stored value is invalid', () => {
    expect(parseOrgSettings({ recruiter: { repeatWindowDays: 500 } }).recruiter.repeatWindowDays).toBe(10);
  });

  it('helper returns the saved value or 10', async () => {
    db.integrationSettings.findUnique.mockResolvedValueOnce({ settings: { recruiter: { repeatWindowDays: 21 } } });
    expect(await getRecruiterRepeatDays('o1')).toBe(21);
    db.integrationSettings.findUnique.mockResolvedValueOnce({ settings: { recruiter: { repeatWindowDays: 0 } } });
    expect(await getRecruiterRepeatDays('o1')).toBe(0);
    db.integrationSettings.findUnique.mockResolvedValueOnce(null);
    expect(await getRecruiterRepeatDays('o1')).toBe(10);
  });
});

describe('POST /api/recruiter-blasts', () => {
  it('creates the draft with the organisation default', async () => {
    db.integrationSettings.findUnique.mockResolvedValueOnce({ settings: { recruiter: { repeatWindowDays: 4 } } });
    await POST(new Request('http://mailflow.test/api/recruiter-blasts', { method: 'POST' }), { params: {} } as never);
    expect(db.recruiterBlast.create.mock.calls[0]?.[0].data.repeatWindowDays).toBe(4);
  });

  it('uses 10 when the organisation never saved one', async () => {
    db.integrationSettings.findUnique.mockResolvedValueOnce(null);
    await POST(new Request('http://mailflow.test/api/recruiter-blasts', { method: 'POST' }), { params: {} } as never);
    expect(db.recruiterBlast.create.mock.calls[0]?.[0].data.repeatWindowDays).toBe(10);
  });
});
