import { describe, it, expect } from 'vitest';
import { checkFrequency, checkStopConditions } from '@/lib/automation/frequency';

const NOW = new Date('2026-09-10T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('checkFrequency — ONCE', () => {
  it('allows the first send', () => {
    expect(checkFrequency({ mode: 'ONCE' }, [], { now: NOW }).allowed).toBe(true);
  });

  it('blocks any subsequent send, however old', () => {
    const decision = checkFrequency({ mode: 'ONCE' }, [{ sentAt: daysAgo(400) }], { now: NOW });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('once per record');
  });
});

describe('checkFrequency — ONCE_PER_DAY / ONCE_PER_WEEK', () => {
  it('blocks a send within 24 hours', () => {
    expect(checkFrequency({ mode: 'ONCE_PER_DAY' }, [{ sentAt: daysAgo(0.5) }], { now: NOW }).allowed).toBe(false);
  });

  it('allows a send after 24 hours', () => {
    expect(checkFrequency({ mode: 'ONCE_PER_DAY' }, [{ sentAt: daysAgo(2) }], { now: NOW }).allowed).toBe(true);
  });

  it('blocks a send within 7 days', () => {
    expect(checkFrequency({ mode: 'ONCE_PER_WEEK' }, [{ sentAt: daysAgo(3) }], { now: NOW }).allowed).toBe(false);
  });

  it('allows a send after 7 days', () => {
    expect(checkFrequency({ mode: 'ONCE_PER_WEEK' }, [{ sentAt: daysAgo(9) }], { now: NOW }).allowed).toBe(true);
  });
});

describe('checkFrequency — ONCE_PER_CAMPAIGN', () => {
  it('blocks a second send within the same campaign', () => {
    const decision = checkFrequency(
      { mode: 'ONCE_PER_CAMPAIGN' },
      [{ sentAt: daysAgo(1), campaignId: 'c1' }],
      { now: NOW, campaignId: 'c1' }
    );
    expect(decision.allowed).toBe(false);
  });

  it('allows a send for a different campaign', () => {
    const decision = checkFrequency(
      { mode: 'ONCE_PER_CAMPAIGN' },
      [{ sentAt: daysAgo(1), campaignId: 'c1' }],
      { now: NOW, campaignId: 'c2' }
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('checkFrequency — ALLOW_REPEATED', () => {
  it('always allows, even with a recent send', () => {
    expect(checkFrequency({ mode: 'ALLOW_REPEATED' }, [{ sentAt: daysAgo(0.01) }], { now: NOW }).allowed).toBe(true);
  });

  it('ignores the cooldown, since repeats are explicitly permitted', () => {
    const decision = checkFrequency(
      { mode: 'ALLOW_REPEATED', cooldownDays: 30 },
      [{ sentAt: daysAgo(1) }],
      { now: NOW }
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('checkFrequency — cooldown (§37)', () => {
  it('blocks within the cooldown window even when the mode would allow it', () => {
    const decision = checkFrequency(
      { mode: 'ONCE_PER_DAY', cooldownDays: 7 },
      [{ sentAt: daysAgo(3) }], // older than a day, but inside the 7-day cooldown
      { now: NOW }
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('7-day cooldown');
  });

  it('allows once the cooldown has elapsed', () => {
    const decision = checkFrequency(
      { mode: 'ONCE_PER_DAY', cooldownDays: 7 },
      [{ sentAt: daysAgo(10) }],
      { now: NOW }
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('checkFrequency — safety', () => {
  it('blocks on an unrecognized mode rather than sending', () => {
    const decision = checkFrequency({ mode: 'NONSENSE' as any }, [], { now: NOW });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('precaution');
  });
});

describe('checkStopConditions (§71)', () => {
  it('does not stop when no conditions are configured', () => {
    expect(checkStopConditions(null, { Reply: 'No' }).stopped).toBe(false);
  });

  it('stops when the condition matches', () => {
    const decision = checkStopConditions(
      { op: 'OR', rules: [{ field: 'ReplyReceived', operator: 'equals', value: 'Yes' }] },
      { ReplyReceived: 'Yes' }
    );
    expect(decision.stopped).toBe(true);
    expect(decision.reason).toContain('ReplyReceived = Yes');
  });

  it('does not stop when the condition does not match', () => {
    const decision = checkStopConditions(
      { op: 'OR', rules: [{ field: 'ReplyReceived', operator: 'equals', value: 'Yes' }] },
      { ReplyReceived: 'No' }
    );
    expect(decision.stopped).toBe(false);
  });

  it('stops if ANY of several stop conditions matches', () => {
    const conditions = {
      op: 'OR' as const,
      rules: [
        { field: 'ReplyReceived', operator: 'equals' as const, value: 'Yes' },
        { field: 'Status', operator: 'equals' as const, value: 'Completed' },
      ],
    };
    expect(checkStopConditions(conditions, { ReplyReceived: 'No', Status: 'Completed' }).stopped).toBe(true);
    expect(checkStopConditions(conditions, { ReplyReceived: 'No', Status: 'Pending' }).stopped).toBe(false);
  });
});
