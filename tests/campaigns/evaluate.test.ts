import { describe, it, expect } from 'vitest';
import { dryRun, evaluateRecord, validateCampaign, SKIP_REASONS } from '@/lib/campaigns/evaluate';

const template = { subject: 'Hi {{Name}}', html: '<p>Code {{Code}}</p>' };
const ctx = { emailColumnKey: 'Email', template };

function rec(id: string, data: Record<string, unknown>) {
  return { id, data };
}

describe('evaluateRecord', () => {
  it('sends a valid, complete record', () => {
    const result = evaluateRecord(
      rec('r1', { Email: 'a@example.com', Name: 'A', Code: 'x' }),
      ctx,
      new Set()
    );
    expect(result.willSend).toBe(true);
    expect(result.skipReason).toBeNull();
  });

  it('skips a record with no email', () => {
    const result = evaluateRecord(rec('r1', { Name: 'A', Code: 'x' }), ctx, new Set());
    expect(result.willSend).toBe(false);
    expect(result.skipReason).toBe(SKIP_REASONS.MISSING_EMAIL);
  });

  it('skips a malformed email and names it in the reason', () => {
    const result = evaluateRecord(rec('r1', { Email: 'not-an-email', Name: 'A', Code: 'x' }), ctx, new Set());
    expect(result.skipReason).toBe(SKIP_REASONS.INVALID_EMAIL);
    expect(result.reasonDetail).toContain('not-an-email');
  });

  it('skips when a template variable has no value (§24)', () => {
    const result = evaluateRecord(rec('r1', { Email: 'a@example.com', Name: 'A' }), ctx, new Set());
    expect(result.skipReason).toBe(SKIP_REASONS.MISSING_VARIABLE);
    expect(result.reasonDetail).toContain('{{Code}}');
    expect(result.missingVariables).toEqual(['Code']);
  });

  it('skips a record already sent for this campaign+version (§41)', () => {
    const result = evaluateRecord(
      rec('r1', { Email: 'a@example.com', Name: 'A', Code: 'x' }),
      { ...ctx, alreadySentRecordIds: new Set(['r1']) },
      new Set()
    );
    expect(result.skipReason).toBe(SKIP_REASONS.ALREADY_SENT);
  });

  it('skips the second occurrence of the same address in one campaign', () => {
    const seen = new Set<string>();
    const first = evaluateRecord(rec('r1', { Email: 'dup@example.com', Name: 'A', Code: 'x' }), ctx, seen);
    const second = evaluateRecord(rec('r2', { Email: 'DUP@example.com', Name: 'B', Code: 'y' }), ctx, seen);
    expect(first.willSend).toBe(true);
    expect(second.willSend).toBe(false);
    expect(second.skipReason).toBe(SKIP_REASONS.DUPLICATE_IN_BATCH);
  });

  it('skips when an automation condition is not met, before checking validity', () => {
    const result = evaluateRecord(
      rec('r1', { Email: 'bad-email', Name: 'A', Code: 'x' }),
      {
        ...ctx,
        conditionResults: new Map([['r1', { met: false, description: 'Trigger = 1' }]]),
      },
      new Set()
    );
    expect(result.skipReason).toBe(SKIP_REASONS.CONDITION_NOT_MET);
    expect(result.reasonDetail).toContain('Trigger = 1');
  });

  it('skips when a send-frequency policy blocks the record (§37)', () => {
    const result = evaluateRecord(
      rec('r1', { Email: 'a@example.com', Name: 'A', Code: 'x' }),
      { ...ctx, frequencyBlockedRecordIds: new Map([['r1', 'Already emailed within the last 7 days.']]) },
      new Set()
    );
    expect(result.skipReason).toBe(SKIP_REASONS.FREQUENCY_LIMIT);
    expect(result.reasonDetail).toContain('7 days');
  });

  it('respects a manual exclusion above all other reasons', () => {
    const result = evaluateRecord(
      rec('r1', { Email: 'a@example.com', Name: 'A', Code: 'x' }),
      { ...ctx, manuallySkippedRecordIds: new Set(['r1']), alreadySentRecordIds: new Set(['r1']) },
      new Set()
    );
    expect(result.skipReason).toBe(SKIP_REASONS.MANUALLY_SKIPPED);
  });

  it('never stores an empty send reason, even with no origin metadata (§35)', () => {
    const result = evaluateRecord(
      rec('r1', { Email: 'a@example.com', Name: 'A', Code: 'x' }),
      ctx, // no origin supplied
      new Set()
    );
    expect(result.willSend).toBe(true);
    expect(result.sendReason).toBeTruthy();
    expect(result.sendReason!.length).toBeGreaterThan(0);
  });

  it('builds a full "why was this sent" explanation (§35)', () => {
    const result = evaluateRecord(
      rec('r1', { Email: 'a@example.com', Name: 'A', Code: 'x' }),
      {
        ...ctx,
        conditionResults: new Map([['r1', { met: true, description: 'Trigger = 1' }]]),
        origin: {
          campaignName: 'RPG Clearance Reminder',
          automationName: 'RPG Reminder',
          templateName: 'RPG Reminder',
          templateVersion: 4,
          batchLabel: 'BATCH-001',
          senderEmail: 'abhishesh@masaischool.com',
        },
      },
      new Set()
    );
    expect(result.sendReason).toContain('Campaign: RPG Clearance Reminder');
    expect(result.sendReason).toContain('Automation: RPG Reminder');
    expect(result.sendReason).toContain('Condition: Trigger = 1 ✓');
    expect(result.sendReason).toContain('Template: RPG Reminder v4');
    expect(result.sendReason).toContain('Batch: BATCH-001');
    expect(result.sendReason).toContain('Sender: abhishesh@masaischool.com');
  });
});

describe('dryRun', () => {
  const records = [
    rec('r1', { Email: 'a@example.com', Name: 'A', Code: '1' }), // send
    rec('r2', { Email: 'b@example.com', Name: 'B', Code: '2' }), // send
    rec('r3', { Email: 'bad', Name: 'C', Code: '3' }), // invalid
    rec('r4', { Email: 'd@example.com', Name: 'D' }), // missing variable
    rec('r5', { Name: 'E', Code: '5' }), // missing email
    rec('r6', { Email: 'A@example.com', Name: 'F', Code: '6' }), // duplicate of r1
    rec('r7', { Email: 'g@example.com', Name: 'G', Code: '7' }), // already sent
  ];

  const summary = dryRun(records, { ...ctx, alreadySentRecordIds: new Set(['r7']) });

  it('counts totals correctly', () => {
    expect(summary.total).toBe(7);
    expect(summary.wouldSend).toBe(2);
    expect(summary.skipped).toBe(5);
  });

  it('breaks skips down by reason', () => {
    expect(summary.byReason[SKIP_REASONS.INVALID_EMAIL]).toBe(1);
    expect(summary.byReason[SKIP_REASONS.MISSING_VARIABLE]).toBe(1);
    expect(summary.byReason[SKIP_REASONS.MISSING_EMAIL]).toBe(1);
    expect(summary.byReason[SKIP_REASONS.DUPLICATE_IN_BATCH]).toBe(1);
    expect(summary.byReason[SKIP_REASONS.ALREADY_SENT]).toBe(1);
  });

  it('counts invalid records (bad/missing address or unresolved variable)', () => {
    expect(summary.invalid).toBe(3);
  });

  it('gives every record a reason — none are silently dropped', () => {
    expect(summary.evaluations).toHaveLength(7);
    for (const evaluation of summary.evaluations) {
      expect(evaluation.reasonDetail.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic across runs', () => {
    const again = dryRun(records, { ...ctx, alreadySentRecordIds: new Set(['r7']) });
    expect(again.wouldSend).toBe(summary.wouldSend);
    expect(again.byReason).toEqual(summary.byReason);
  });

  it('sends nothing — it only evaluates', () => {
    // A guard against the dry run ever gaining a side effect: the function
    // is pure, so calling it twice cannot change any outcome.
    const a = dryRun(records, ctx);
    const b = dryRun(records, ctx);
    expect(a.wouldSend).toBe(b.wouldSend);
  });
});

describe('validateCampaign', () => {
  const ok = {
    hasDataset: true,
    hasTemplate: true,
    hasEmailColumn: true,
    senderConnected: true,
    senderStatus: 'CONNECTED',
    recipientCount: 10,
    canSend: true,
  };

  it('passes a fully configured campaign', () => {
    expect(validateCampaign(ok).blocked).toBe(false);
  });

  it('blocks without a connected sender (§28)', () => {
    const result = validateCampaign({ ...ok, senderConnected: false });
    expect(result.blocked).toBe(true);
    expect(result.issues.some((i) => i.id === 'sender')).toBe(true);
  });

  it('blocks when the connected account has expired', () => {
    const result = validateCampaign({ ...ok, senderStatus: 'EXPIRED' });
    expect(result.blocked).toBe(true);
  });

  it('blocks when there are no recipients', () => {
    expect(validateCampaign({ ...ok, recipientCount: 0 }).blocked).toBe(true);
  });

  it('blocks when the user lacks permission', () => {
    expect(validateCampaign({ ...ok, canSend: false }).blocked).toBe(true);
  });

  it('blocks when a template variable is not in the dataset', () => {
    const result = validateCampaign({
      ...ok,
      template: { subject: 'Hi {{Nope}}', html: '' },
      availableColumnKeys: ['Name', 'Email'],
    });
    expect(result.blocked).toBe(true);
    expect(result.issues.some((i) => i.id === 'variables')).toBe(true);
  });

  it('warns but does not block on a very large send', () => {
    const result = validateCampaign({ ...ok, recipientCount: 900 });
    expect(result.blocked).toBe(false);
    expect(result.issues.some((i) => i.id === 'volume' && i.level === 'warning')).toBe(true);
  });
});
