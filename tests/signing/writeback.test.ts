import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { documentState } from '@/lib/signing/writeback';

const now = new Date('2026-09-27T12:00:00Z');
const m = (over: Partial<{ status: string; signerOrder: number; sentAt: Date | null; signedAt: Date | null; token: string }>) => ({
  status: 'SENT',
  signerOrder: 0,
  sentAt: new Date('2026-09-24T10:00:00Z'),
  signedAt: null,
  token: 't0',
  ...over,
});

describe('documentState', () => {
  it('a sent document counts the days waiting', () => {
    expect(documentState([m({})], null, now)).toMatchObject({ status: 'Sent', daysWaiting: 3, signedAt: null, leadToken: 't0' });
  });

  it('viewed beats sent', () => {
    expect(documentState([m({ status: 'VIEWED' })], null, now).status).toBe('Viewed');
  });

  it('shows partial progress for multi-signer documents and keeps waiting', () => {
    const s = documentState([m({ status: 'SIGNED', signedAt: now }), m({ signerOrder: 1, token: 't1' })], 'IN_PROGRESS', now);
    expect(s.status).toBe('Signed 1/2');
    expect(s.daysWaiting).toBe(3);
    expect(s.signedAt).toBeNull();
  });

  it('signed when everyone has signed; signed date is the last signature; lead is signer 1', () => {
    const late = new Date('2026-09-26T09:00:00Z');
    const s = documentState(
      [m({ signerOrder: 1, token: 't1', status: 'SIGNED', signedAt: late }), m({ status: 'SIGNED', signedAt: new Date('2026-09-25T09:00:00Z') })],
      'COMPLETED',
      now,
    );
    expect(s).toMatchObject({ status: 'Signed', signedAt: late, daysWaiting: null, leadToken: 't0' });
  });

  it('voided and expired stop the waiting clock', () => {
    expect(documentState([m({ status: 'VOIDED' })], null, now)).toMatchObject({ status: 'Voided', daysWaiting: null });
    expect(documentState([m({ status: 'EXPIRED' })], null, now)).toMatchObject({ status: 'Expired', daysWaiting: null });
    expect(documentState([m({})], 'VOIDED', now).status).toBe('Voided');
  });

  it('draft with no send date has no waiting days', () => {
    expect(documentState([m({ status: 'DRAFT', sentAt: null })], null, now)).toMatchObject({ status: 'Draft', daysWaiting: null, sentAt: null });
  });
});
