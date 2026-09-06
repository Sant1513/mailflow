import { describe, it, expect } from 'vitest';
import {
  EMPTY_POLICY,
  MIN_RETENTION_DAYS,
  cutoffFor,
  policyDiff,
  retentionPolicySchema,
} from '@/lib/retention/policy';

const NOW = new Date('2026-09-05T06:30:00Z');

describe('retentionPolicySchema (§130)', () => {
  it('accepts null (keep forever) for every field', () => {
    expect(retentionPolicySchema.parse(EMPTY_POLICY)).toEqual(EMPTY_POLICY);
  });

  it('accepts whole days within bounds', () => {
    const ok = { messageBodyDays: 365, emailJobBodyDays: 90, auditLogDays: 3650 };
    expect(retentionPolicySchema.parse(ok)).toEqual(ok);
  });

  it('rejects windows short enough to erase live threads', () => {
    expect(() => retentionPolicySchema.parse({ ...EMPTY_POLICY, messageBodyDays: MIN_RETENTION_DAYS - 1 })).toThrow();
    expect(() => retentionPolicySchema.parse({ ...EMPTY_POLICY, messageBodyDays: 0 })).toThrow();
  });

  it('rejects fractions, strings, absurd values and missing fields', () => {
    expect(() => retentionPolicySchema.parse({ ...EMPTY_POLICY, auditLogDays: 30.5 })).toThrow();
    expect(() => retentionPolicySchema.parse({ ...EMPTY_POLICY, auditLogDays: '30' })).toThrow();
    expect(() => retentionPolicySchema.parse({ ...EMPTY_POLICY, auditLogDays: 100_000 })).toThrow();
    expect(() => retentionPolicySchema.parse({ messageBodyDays: 30 })).toThrow();
  });
});

describe('cutoffFor', () => {
  it('is null when the rule is off', () => {
    expect(cutoffFor(null, NOW)).toBeNull();
    expect(cutoffFor(undefined, NOW)).toBeNull();
  });

  it('is exactly N days before now', () => {
    expect(cutoffFor(30, NOW)?.toISOString()).toBe('2026-08-06T06:30:00.000Z');
  });

  it('refuses to compute a cutoff below the minimum, even if a caller bypassed the schema', () => {
    expect(() => cutoffFor(7, NOW)).toThrow();
    expect(() => cutoffFor(30.5, NOW)).toThrow();
  });
});

describe('policyDiff', () => {
  it('records only the fields that changed, with from/to', () => {
    const before = { messageBodyDays: null, emailJobBodyDays: 90, auditLogDays: 365 };
    const after = { messageBodyDays: 180, emailJobBodyDays: 90, auditLogDays: null };
    expect(policyDiff(before, after)).toEqual({
      messageBodyDays: { from: null, to: 180 },
      auditLogDays: { from: 365, to: null },
    });
  });

  it('is empty when nothing changed', () => {
    expect(policyDiff(EMPTY_POLICY, { ...EMPTY_POLICY })).toEqual({});
  });
});
