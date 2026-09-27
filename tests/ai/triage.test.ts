import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/conversations/notify', () => ({ notifyAssignment: vi.fn() }));

import { ConversationStatus } from '@prisma/client';
import { decideTriage, draftToHtml, type TriageInput } from '@/lib/ai/triage';
import { parseOrgSettings } from '@/lib/settings/org-schema';

const triage = parseOrgSettings({}).triage;
const base: TriageInput = {
  intent: 'QUESTION',
  confidence: 0.9,
  assigneeId: null,
  ownerId: 'owner',
  status: ConversationStatus.OPEN,
  hasOutbound: true,
};

describe('decideTriage', () => {
  it('tags, assigns to the owner and drafts for a question', () => {
    expect(decideTriage(triage, base)).toEqual({ tag: 'Question', assignTo: 'owner', resolve: false, draft: true });
  });

  it('assigns by intent when configured', () => {
    const s = { ...triage, assignByIntent: { COMPLAINT: 'lead' } };
    expect(decideTriage(s, { ...base, intent: 'COMPLAINT' }).assignTo).toBe('lead');
  });

  it('never reassigns a conversation someone already has', () => {
    expect(decideTriage(triage, { ...base, assigneeId: 'someone' }).assignTo).toBeNull();
  });

  it('closes a confident thank-you after the team has replied, without assigning or drafting', () => {
    expect(decideTriage(triage, { ...base, intent: 'ACKNOWLEDGEMENT' })).toEqual({ tag: 'Thanks', assignTo: null, resolve: true, draft: false });
  });

  it('does not close a thank-you with low confidence, no prior team reply, or already closed', () => {
    expect(decideTriage(triage, { ...base, intent: 'ACKNOWLEDGEMENT', confidence: 0.6 }).resolve).toBe(false);
    expect(decideTriage(triage, { ...base, intent: 'ACKNOWLEDGEMENT', hasOutbound: false }).resolve).toBe(false);
    expect(decideTriage(triage, { ...base, intent: 'ACKNOWLEDGEMENT', status: ConversationStatus.RESOLVED }).resolve).toBe(false);
  });

  it('ignores intents it does not triage', () => {
    expect(decideTriage(triage, { ...base, intent: 'OUT_OF_OFFICE' })).toEqual({ tag: null, assignTo: null, resolve: false, draft: false });
  });

  it('respects each switch, and the master switch', () => {
    expect(decideTriage({ ...triage, enabled: false }, base)).toEqual({ tag: null, assignTo: null, resolve: false, draft: false });
    expect(decideTriage({ ...triage, autoTag: false }, base).tag).toBeNull();
    expect(decideTriage({ ...triage, autoAssign: false }, base).assignTo).toBeNull();
    expect(decideTriage({ ...triage, draftReplies: false }, base).draft).toBe(false);
    expect(decideTriage({ ...triage, autoResolveAcknowledgements: false }, { ...base, intent: 'ACKNOWLEDGEMENT' }).resolve).toBe(false);
  });
});

describe('draftToHtml', () => {
  it('turns paragraphs and line breaks into HTML and escapes', () => {
    expect(draftToHtml('Hi Asha,\n\nYes <b>tomorrow</b>.\nThanks\n\nRegards,\nTeam')).toBe(
      '<p>Hi Asha,</p><p>Yes &lt;b&gt;tomorrow&lt;/b&gt;.<br>Thanks</p><p>Regards,<br>Team</p>',
    );
  });
});
