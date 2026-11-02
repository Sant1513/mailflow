import { describe, expect, it, vi, beforeEach } from 'vitest';

const db = {
  conversation: { findUnique: vi.fn(), update: vi.fn() },
  emailJob: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  followUp: { updateMany: vi.fn() },
  scheduledReply: { updateMany: vi.fn(), create: vi.fn() },
  record: { update: vi.fn() },
  emailSuppression: { upsert: vi.fn() },
  templateVersion: { findFirst: vi.fn() },
  notification: { create: vi.fn(async () => ({})) },
  internalNote: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@/lib/records/systemUpdate', () => ({ ensureColumns: vi.fn(), updateRecordFields: vi.fn(async () => ({ changed: [] })) }));
vi.mock('@/lib/ai/triage', () => ({ tagConversation: vi.fn(), AI_DRAFT_STATUS: 'DRAFT' }));
vi.mock('@/lib/conversations/notify', () => ({ notifyAssignment: vi.fn(async () => undefined) }));

const { pickRule, exampleReplyRules, readReplyRules } = await import('@/lib/replyRules/config');
const { applyReplyRules } = await import('@/lib/replyRules/apply');
const systemUpdate = await import('@/lib/records/systemUpdate');

const conversation = {
  id: 'cv1', organizationId: 'o1', workspaceId: 'w1', ownerId: 'u1', assigneeId: null, status: 'OPEN', contactId: 'ct1',
  recipientEmail: 'Rahul@Example.com', subject: 'Drive', emailProviderAccountId: 'acc1', gmailThreadId: 't1',
};
const job = (replyRules: unknown) => ({
  campaignId: 'c1', recordId: 'r1', record: { data: { Name: 'Rahul' } },
  campaign: { id: 'c1', name: 'Placement drive', createdById: 'u1', datasetId: 'd1', replyRules },
});

beforeEach(() => {
  vi.clearAllMocks();
  db.conversation.findUnique.mockResolvedValue(conversation);
});

describe('picking a rule', () => {
  const rules = exampleReplyRules();
  it('matches by reply type and confidence; first match wins', () => {
    expect(pickRule(rules, 'INTERESTED', 0.9)?.id).toBe('interested');
    expect(pickRule(rules, 'INTERESTED', 0.5)).toBeNull();
    expect(pickRule(rules, 'REQUEST', 0.65)?.id).toBe('question');
    expect(pickRule(rules, 'ACKNOWLEDGEMENT', 0.99)).toBeNull();
  });
  it('treats off or empty settings as no rules', () => {
    expect(readReplyRules({ ...rules, enabled: false })).toBeNull();
    expect(readReplyRules({ enabled: true, rules: [] })).toBeNull();
    expect(readReplyRules(null)).toBeNull();
  });
});

describe('running a rule', () => {
  it('"not interested": writes the column, stops follow-ups and closes the conversation', async () => {
    db.emailJob.findFirst.mockResolvedValue(job(exampleReplyRules()));
    const rule = await applyReplyRules({ conversationId: 'cv1', intent: 'NOT_INTERESTED', confidence: 0.92 });
    expect(rule?.id).toBe('not_interested');
    expect(systemUpdate.updateRecordFields).toHaveBeenCalledWith(expect.objectContaining({ recordId: 'r1', fields: { Reply_status: 'Not interested' } }));
    expect(db.followUp.updateMany).toHaveBeenCalled();
    expect(db.scheduledReply.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'PENDING' }) }));
    expect(db.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'RESOLVED' }) }));
    expect(db.internalNote.create).toHaveBeenCalled();
  });

  it('replies with a template: a draft for approval by default, sent at once when set to auto', async () => {
    const rules = exampleReplyRules();
    rules.rules[0]!.actions.replyTemplateId = 'tpl1';
    db.templateVersion.findFirst.mockResolvedValue({ subject: 'Next steps', html: '<p>Hi {{Name}}</p>', plainText: null, css: null });
    db.emailJob.findFirst.mockResolvedValue(job(rules));
    await applyReplyRules({ conversationId: 'cv1', intent: 'INTERESTED', confidence: 0.9 });
    expect(db.scheduledReply.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DRAFT', html: expect.stringContaining('Hi Rahul') }) }));

    vi.clearAllMocks();
    db.conversation.findUnique.mockResolvedValue(conversation);
    rules.rules[0]!.actions.replyMode = 'auto';
    db.emailJob.findFirst.mockResolvedValue(job(rules));
    await applyReplyRules({ conversationId: 'cv1', intent: 'INTERESTED', confidence: 0.9 });
    expect(db.scheduledReply.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }));
  });

  it('auto-reply with an empty field waits for approval instead of sending a gap', async () => {
    const rules = exampleReplyRules();
    rules.rules[0]!.actions.replyTemplateId = 'tpl1';
    rules.rules[0]!.actions.replyMode = 'auto';
    db.templateVersion.findFirst.mockResolvedValue({ subject: 'Next steps', html: '<p>Hi {{Nickname}}</p>', plainText: null, css: null });
    db.emailJob.findFirst.mockResolvedValue(job(rules));
    await applyReplyRules({ conversationId: 'cv1', intent: 'INTERESTED', confidence: 0.9 });
    expect(db.scheduledReply.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DRAFT' }) }));
  });

  it('does nothing for conversations that no campaign started, or with rules off', async () => {
    db.emailJob.findFirst.mockResolvedValue(null);
    expect(await applyReplyRules({ conversationId: 'cv1', intent: 'INTERESTED', confidence: 0.9 })).toBeNull();
    db.emailJob.findFirst.mockResolvedValue(job({ ...exampleReplyRules(), enabled: false }));
    expect(await applyReplyRules({ conversationId: 'cv1', intent: 'INTERESTED', confidence: 0.9 })).toBeNull();
    expect(db.internalNote.create).not.toHaveBeenCalled();
  });
});
