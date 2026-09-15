import { describe, it, expect } from 'vitest';
import { dryRun, evaluateRecord, validateCampaign, SKIP_REASONS, type EvaluationContext } from '@/lib/campaigns/evaluate';

const ctx = (documents: EvaluationContext['documents']): EvaluationContext => ({
  emailColumnKey: 'Email',
  template: { subject: 'Hi {{Name}}', html: '<p>Hi {{Name}}</p>' },
  documents,
});

const offerLetter = [
  {
    name: 'Offer Letter',
    fields: [
      { label: 'Joining date', value: '{{JoiningDate}}', required: true },
      { label: 'Mentor', value: '{{Mentor}}', required: false },
      { label: 'Reference', value: '{{DocumentId}} issued {{Today}}', required: true },
    ],
  },
];

describe('dry run with personalised documents', () => {
  it('skips a record whose required document value is empty, naming the document and the field', () => {
    const e = evaluateRecord({ id: 'r1', data: { Email: 'a@example.com', Name: 'Asha', JoiningDate: ' ' } }, ctx(offerLetter), new Set());
    expect(e.willSend).toBe(false);
    expect(e.skipReason).toBe(SKIP_REASONS.MISSING_DOCUMENT_FIELD);
    expect(e.reasonDetail).toBe('Missing document value: Offer Letter: Joining date ({{JoiningDate}}).');
  });

  it('sends when only optional values are empty; system variables need no column', () => {
    const e = evaluateRecord({ id: 'r1', data: { Email: 'a@example.com', Name: 'Asha', JoiningDate: '2026-10-01' } }, ctx(offerLetter), new Set());
    expect(e.willSend).toBe(true);
  });

  it('counts missing document values as invalid and does not reserve the address for the skipped row', () => {
    const summary = dryRun(
      [
        { id: 'r1', data: { Email: 'a@example.com', Name: 'Asha' } },
        { id: 'r2', data: { Email: 'a@example.com', Name: 'Asha', JoiningDate: '2026-10-01' } },
      ],
      ctx(offerLetter)
    );
    expect(summary.wouldSend).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(summary.byReason.MISSING_DOCUMENT_FIELD).toBe(1);
    expect(summary.evaluations[1]?.willSend).toBe(true);
  });

  it('a campaign without documents is unaffected', () => {
    expect(evaluateRecord({ id: 'r1', data: { Email: 'a@example.com', Name: 'Asha' } }, ctx(undefined), new Set()).willSend).toBe(true);
  });
});

describe('validateCampaign with document issues', () => {
  it('blocks on a document error and lists warnings without blocking', () => {
    const base = { hasDataset: true, hasTemplate: true, hasEmailColumn: true, senderConnected: true, recipientCount: 3, canSend: true };
    const blocked = validateCampaign({ ...base, documentIssues: [{ level: 'error', message: 'Offer Letter: bad field' }, { level: 'warning', message: 'w' }] });
    expect(blocked.blocked).toBe(true);
    expect(blocked.issues.map((i) => i.id)).toEqual(['document-0', 'document-1']);
    expect(validateCampaign({ ...base, documentIssues: [{ level: 'warning', message: 'w' }] }).blocked).toBe(false);
  });
});
