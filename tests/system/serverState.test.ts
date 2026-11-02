import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
const { autoTransition, laptopOnline, LAPTOP_SILENT_MS, SWITCH_TO_CLOUD_TIMEOUT_MS, SWITCH_TO_LAPTOP_TIMEOUT_MS } = await import(
  '@/lib/system/serverState'
);

const now = new Date('2026-11-02T10:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const base = { activeServer: 'cloud', switchTo: null, switchStartedAt: null, lastLaptopSeenAt: ago(5_000), lastSyncAt: ago(3_600_000) };

describe('server switch: automatic safety moves', () => {
  it('does nothing in the normal states', () => {
    expect(autoTransition(base, now)).toBeNull();
    expect(autoTransition({ ...base, activeServer: 'laptop' }, now)).toBeNull();
    expect(autoTransition({ ...base, switchTo: 'laptop', switchStartedAt: ago(60_000) }, now)).toBeNull();
  });

  it('cancels a switch to the laptop that the laptop never finished (stays on the cloud)', () => {
    const change = autoTransition({ ...base, switchTo: 'laptop', switchStartedAt: ago(SWITCH_TO_LAPTOP_TIMEOUT_MS + 1) }, now);
    expect(change).toMatchObject({ switchTo: null, switchStartedAt: null });
    expect(change).not.toHaveProperty('activeServer');
  });

  it('moves to the cloud when the active laptop has gone silent', () => {
    const silent = { ...base, activeServer: 'laptop', lastLaptopSeenAt: ago(LAPTOP_SILENT_MS + 1) };
    expect(autoTransition(silent, now)).toMatchObject({ activeServer: 'cloud' });
    // A laptop that is still talking keeps the job, however flaky its public address is:
    // the laptop itself hands over in that case, with a full copy.
    expect(autoTransition({ ...silent, lastLaptopSeenAt: ago(LAPTOP_SILENT_MS - 1000) }, now)).toBeNull();
    // Never heard from at all counts as silent.
    expect(autoTransition({ ...silent, lastLaptopSeenAt: null }, now)).toMatchObject({ activeServer: 'cloud' });
  });

  it('finishes a switch to the cloud without the laptop only once the laptop has stopped answering', () => {
    const stuck = { ...base, activeServer: 'laptop', switchTo: 'cloud', switchStartedAt: ago(SWITCH_TO_CLOUD_TIMEOUT_MS + 1) };
    expect(autoTransition({ ...stuck, lastLaptopSeenAt: ago(5 * 60_000) }, now)).toMatchObject({ activeServer: 'cloud', switchTo: null });
    // Still copying (heartbeat fresh): leave it to finish.
    expect(autoTransition(stuck, now)).toBeNull();
  });

  it('reports the laptop online only on a recent heartbeat', () => {
    expect(laptopOnline({ lastLaptopSeenAt: ago(30_000) }, now)).toBe(true);
    expect(laptopOnline({ lastLaptopSeenAt: ago(3 * 60_000) }, now)).toBe(false);
    expect(laptopOnline({ lastLaptopSeenAt: null }, now)).toBe(false);
  });
});
