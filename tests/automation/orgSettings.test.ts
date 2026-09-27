import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { deepMerge, parseOrgSettings } from '@/lib/settings/org';
import { digestTotal, renderDigestEmail, renderDigestSlack, type NeedsAttention } from '@/lib/digest/needsAttention';

describe('org settings', () => {
  it('defaults everything when nothing is stored', () => {
    const s = parseOrgSettings(null);
    expect(s.digest).toMatchObject({ enabled: true, emailAdmins: true, slack: true, expiringWithinHours: 48, unansweredAfterHours: 24 });
    expect(s.weeklyReport).toMatchObject({ enabled: true, emailSuperAdmins: true, slack: false });
    expect(s.triage).toMatchObject({ enabled: true, autoResolveMinConfidence: 0.85 });
    expect(s.senderAccountId).toBeNull();
  });

  it('fills newer keys into older stored settings', () => {
    const s = parseOrgSettings({ digest: { enabled: false } });
    expect(s.digest.enabled).toBe(false);
    expect(s.digest.unansweredAfterHours).toBe(24);
    expect(s.triage.enabled).toBe(true);
  });

  it('falls back to defaults on invalid data rather than throwing', () => {
    expect(parseOrgSettings({ digest: { expiringWithinHours: 'lots' } }).digest.expiringWithinHours).toBe(48);
  });

  it('deep-merges a patch without dropping siblings', () => {
    const merged = deepMerge(parseOrgSettings({}), { digest: { slack: false }, triage: { assignByIntent: { QUESTION: 'u1' } } });
    expect(merged.digest.slack).toBe(false);
    expect(merged.digest.enabled).toBe(true);
    expect(merged.triage.assignByIntent).toEqual({ QUESTION: 'u1' });
    expect(merged.weeklyReport.enabled).toBe(true);
  });
});

const empty: NeedsAttention = {
  generatedAt: new Date('2026-09-28T03:30:00Z'),
  expiringDocuments: [],
  slaBreaches: [],
  pendingCampaigns: [],
  pendingUsers: [],
  unansweredReplies: [],
};

describe('digest rendering', () => {
  it('all clear when nothing is waiting', () => {
    expect(digestTotal(empty)).toBe(0);
    expect(renderDigestEmail(empty).subject).toBe('[MailFlow] All clear today');
    expect(renderDigestSlack(empty)).toMatch(/nothing needs attention/);
  });

  it('counts and lists what needs attention, escaping user text', () => {
    const d: NeedsAttention = {
      ...empty,
      unansweredReplies: [{ title: 'Re: <Offer>', detail: 'Asha · 30h', workspace: 'Placements', href: 'https://x/inbox/1' }],
      expiringDocuments: [
        { title: 'Offer letter', detail: 'expires in 20h', workspace: 'Placements', href: 'https://x/d/1' },
        { title: 'NDA', detail: 'expires in 40h', workspace: 'Placements', href: 'https://x/d/2' },
      ],
    };
    expect(digestTotal(d)).toBe(3);
    const email = renderDigestEmail(d);
    expect(email.subject).toBe('[MailFlow] 3 things need attention today');
    expect(email.html).toContain('Re: &lt;Offer&gt;');
    expect(email.html).not.toContain('<Offer>');
    const slack = renderDigestSlack(d);
    expect(slack).toContain('*1* replies waiting for an answer');
    expect(slack).toContain('*2* documents expiring unsigned');
    expect(slack).not.toContain('campaigns waiting');
  });
});
