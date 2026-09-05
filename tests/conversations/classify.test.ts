import { describe, it, expect } from 'vitest';
import { classifyInbound, countsAsReply } from '@/lib/conversations/classify';

function msg(opts: { from?: string; subject?: string; headers?: Record<string, string>; body?: string }) {
  const from = opts.from ?? 'rahul@example.com';
  return {
    headers: { from, subject: opts.subject ?? 'Re: RPG', ...(opts.headers ?? {}) },
    from: { name: null, email: from },
    subject: opts.subject ?? 'Re: RPG',
    plainTextBody: opts.body ?? 'hello',
  };
}

describe('classifyInbound — a normal human reply', () => {
  it('is HUMAN_REPLY when nothing automated is present', () => {
    const r = classifyInbound(msg({ subject: 'Re: RPG Clearance', body: 'I have completed it.' }));
    expect(r.classification).toBe('HUMAN_REPLY');
    expect(countsAsReply(r.classification)).toBe(true);
  });
});

describe('classifyInbound — bounces and delivery failures', () => {
  it('flags mailer-daemon senders as BOUNCE', () => {
    const r = classifyInbound(msg({ from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)' }));
    expect(r.classification).toBe('BOUNCE');
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(countsAsReply(r.classification)).toBe(false);
  });

  it('flags postmaster senders as BOUNCE', () => {
    expect(classifyInbound(msg({ from: 'postmaster@example.com' })).classification).toBe('BOUNCE');
  });

  it('flags multipart/report delivery-status content as DELIVERY_FAILURE', () => {
    const r = classifyInbound(msg({ headers: { 'content-type': 'multipart/report; report-type=delivery-status' } }));
    expect(r.classification).toBe('DELIVERY_FAILURE');
  });

  it('flags "Undeliverable" subjects from a normal-looking sender', () => {
    expect(classifyInbound(msg({ subject: 'Undeliverable: RPG Clearance' })).classification).toBe('DELIVERY_FAILURE');
    expect(classifyInbound(msg({ subject: 'Mail delivery failed: returning message' })).classification).toBe('DELIVERY_FAILURE');
  });
});

describe('classifyInbound — out of office', () => {
  it('uses Auto-Submitted: auto-replied', () => {
    const r = classifyInbound(msg({ headers: { 'auto-submitted': 'auto-replied' } }));
    expect(r.classification).toBe('OUT_OF_OFFICE');
    expect(countsAsReply(r.classification)).toBe(false);
  });

  it('uses X-Auto-Response-Suppress: OOF', () => {
    expect(classifyInbound(msg({ headers: { 'x-auto-response-suppress': 'OOF' } })).classification).toBe('OUT_OF_OFFICE');
  });

  it('uses an out-of-office subject with no headers', () => {
    expect(classifyInbound(msg({ subject: 'Out of Office: Re: RPG' })).classification).toBe('OUT_OF_OFFICE');
    expect(classifyInbound(msg({ subject: 'Automatic reply: RPG Clearance' })).classification).toBe('OUT_OF_OFFICE');
    expect(classifyInbound(msg({ subject: 'I am on leave until Monday' })).classification).toBe('OUT_OF_OFFICE');
  });

  it('does NOT ignore Auto-Submitted: no', () => {
    expect(classifyInbound(msg({ headers: { 'auto-submitted': 'no' } })).classification).toBe('HUMAN_REPLY');
  });
});

describe('classifyInbound — other automated mail', () => {
  it('treats Auto-Submitted: auto-generated as AUTO_REPLY', () => {
    expect(classifyInbound(msg({ headers: { 'auto-submitted': 'auto-generated' } })).classification).toBe('AUTO_REPLY');
  });

  it('treats list traffic as AUTO_REPLY', () => {
    expect(classifyInbound(msg({ headers: { 'list-unsubscribe': '<mailto:x>' } })).classification).toBe('AUTO_REPLY');
    expect(classifyInbound(msg({ headers: { precedence: 'bulk' } })).classification).toBe('AUTO_REPLY');
  });

  it('treats no-reply senders as AUTO_REPLY', () => {
    expect(classifyInbound(msg({ from: 'noreply@notifications.example' })).classification).toBe('AUTO_REPLY');
    expect(classifyInbound(msg({ from: 'do-not-reply@example.com' })).classification).toBe('AUTO_REPLY');
  });
});

describe('classifyInbound — precedence between signals', () => {
  it('a bounce sender wins even with a human-looking subject', () => {
    expect(classifyInbound(msg({ from: 'mailer-daemon@x.test', subject: 'Re: thanks!' })).classification).toBe('BOUNCE');
  });

  it('an explicit machine header wins over a human-looking subject', () => {
    const r = classifyInbound(msg({ subject: 'Re: RPG', headers: { 'auto-submitted': 'auto-replied' } }));
    expect(r.classification).toBe('OUT_OF_OFFICE');
  });
});

describe('classifyInbound — edge cases', () => {
  it('is UNKNOWN with low confidence when there is no sender', () => {
    const r = classifyInbound({ headers: {}, from: null, subject: 'x', plainTextBody: '' });
    expect(r.classification).toBe('UNKNOWN');
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('always returns a reason string', () => {
    for (const m of [msg({}), msg({ from: 'mailer-daemon@x' }), msg({ headers: { 'auto-submitted': 'auto-replied' } })]) {
      expect(classifyInbound(m).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('countsAsReply', () => {
  it.each([
    ['HUMAN_REPLY', true],
    ['OUT_OF_OFFICE', false],
    ['BOUNCE', false],
    ['DELIVERY_FAILURE', false],
    ['AUTO_REPLY', false],
    ['UNKNOWN', false],
  ] as const)('%s -> %s', (c, expected) => {
    expect(countsAsReply(c)).toBe(expected);
  });
});
