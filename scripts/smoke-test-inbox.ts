/**
 * End-to-end inbound pipeline test against the REAL database, with a fake
 * Gmail source so no mailbox is touched.
 *
 * Proves: a reply to a campaign email lands in the right conversation
 * (matched by In-Reply-To -> our Message-ID), bounces are stored but never
 * count as "the student replied", duplicates are ignored, unrelated mail is
 * left alone, the same thread accumulates, and syncAccount advances the
 * history cursor and falls back to a scan when history is gone.
 *
 * Usage: npx tsx scripts/smoke-test-inbox.ts
 */
import { prisma } from '../lib/db/client';
import { ingestInboundMessage } from '../lib/gmail/ingest';
import { syncAccount, GmailHistoryGone, type GmailSource } from '../lib/gmail/sync';
import { parseGmailMessage, type GmailMessage } from '../lib/gmail/parseMessage';
import { Role, ColumnType, CampaignStatus, BatchStatus, EmailJobStatus, EmailProvider as EmailProviderEnum } from '@prisma/client';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function gmailMsg(opts: {
  id: string; threadId: string; from: string; to: string; subject: string;
  messageId: string; inReplyTo?: string; references?: string; text: string;
  labels?: string[]; headers?: Record<string, string>;
}): GmailMessage {
  const headers: Record<string, string> = {
    From: opts.from, To: opts.to, Subject: opts.subject, 'Message-ID': opts.messageId,
    Date: new Date().toUTCString(), ...(opts.headers ?? {}),
  };
  if (opts.inReplyTo) headers['In-Reply-To'] = opts.inReplyTo;
  if (opts.references) headers['References'] = opts.references;
  return {
    id: opts.id, threadId: opts.threadId, labelIds: opts.labels ?? ['INBOX', 'UNREAD'],
    snippet: opts.text.slice(0, 80), internalDate: String(Date.now()),
    payload: {
      mimeType: 'multipart/alternative',
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      parts: [
        { mimeType: 'text/plain', body: { data: b64url(opts.text) } },
        { mimeType: 'text/html', body: { data: b64url(`<p>${opts.text}</p>`) } },
      ],
    },
  };
}

async function main() {
  console.log('=== MailFlow inbox/ingestion test (real DB, fake Gmail) ===\n');
  const stamp = Date.now();
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });

  const user = await prisma.user.create({
    data: { organizationId: org.id, googleId: `inbox-smoke-${stamp}`, email: `inbox-smoke+${stamp}@masaischool.com`, name: 'Inbox Smoke', role: Role.OPERATOR },
  });
  const workspace = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: user.id, name: 'Inbox Smoke WS' } });
  const account = await prisma.emailProviderAccount.create({
    data: { organizationId: org.id, workspaceId: workspace.id, userId: user.id, provider: EmailProviderEnum.GMAIL, emailAddress: user.email, displayName: user.name, status: 'CONNECTED' },
  });

  const studentEmail = `rahul-${stamp}@example.com`;
  const contact = await prisma.contact.create({
    data: { organizationId: org.id, workspaceId: workspace.id, primaryEmail: studentEmail, name: 'Rahul' },
  });
  const dataset = await prisma.dataset.create({
    data: {
      organizationId: org.id, workspaceId: workspace.id, ownerId: user.id, name: 'Inbox Smoke DS',
      columns: { create: [{ key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 1 }] },
    },
  });
  const record = await prisma.record.create({ data: { datasetId: dataset.id, contactId: contact.id, data: { Email: studentEmail } } });

  const template = await prisma.template.create({
    data: {
      organizationId: org.id, workspaceId: workspace.id, ownerId: user.id, name: 'Inbox Smoke T',
      versions: { create: { version: 1, subject: 'RPG Clearance', html: '<p>x</p>', variables: [], createdById: user.id } },
    },
    include: { versions: true },
  });
  const campaign = await prisma.campaign.create({
    data: {
      organizationId: org.id, workspaceId: workspace.id, name: 'Inbox Smoke C', datasetId: dataset.id,
      templateId: template.id, templateVersionId: template.versions[0]!.id, createdById: user.id, status: CampaignStatus.COMPLETED,
    },
  });
  const batch = await prisma.batch.create({ data: { campaignId: campaign.id, label: `B-${stamp}`, status: BatchStatus.COMPLETED, total: 1, validCount: 1, sentCount: 1 } });

  // The campaign email we "sent": its Message-ID is what the reply references.
  const ourMessageId = `<campaign-${stamp}@masaischool.com>`;
  const threadId = `thread-${stamp}`;
  await prisma.emailJob.create({
    data: {
      batchId: batch.id, campaignId: campaign.id, recordId: record.id, templateVersionId: template.versions[0]!.id,
      emailProviderAccountId: account.id, status: EmailJobStatus.SENT, toEmail: studentEmail, ccEmails: [], bccEmails: [],
      fromName: user.name, fromEmail: user.email, subject: 'RPG Clearance', html: '<p>x</p>',
      gmailMessageId: `sent-${stamp}`, gmailThreadId: threadId, messageIdHeader: ourMessageId, sentAt: new Date(),
    },
  });

  // ── 1. A real reply threads onto the campaign email ──
  console.log('-- Reply to a campaign email --');
  const reply = parseGmailMessage(gmailMsg({
    id: `reply-${stamp}`, threadId, from: `Rahul <${studentEmail}>`, to: user.email,
    subject: 'Re: RPG Clearance', messageId: `<r1-${stamp}@example.com>`,
    inReplyTo: ourMessageId, references: ourMessageId, text: 'I have completed the RPG.',
  }));
  const r1 = await ingestInboundMessage(account, reply);
  check('reply is STORED', r1.status === 'STORED', r1);
  check('a new conversation was created', r1.status === 'STORED' && r1.created);
  check('classified HUMAN_REPLY', r1.status === 'STORED' && r1.classification === 'HUMAN_REPLY');

  const conv = await prisma.conversation.findUnique({
    where: { emailProviderAccountId_gmailThreadId: { emailProviderAccountId: account.id, gmailThreadId: threadId } },
    include: { messages: true },
  });
  check('conversation keyed by (account, threadId)', !!conv);
  check('conversation linked to the right contact', conv?.contactId === contact.id);
  check('conversation subject normalized (Re: stripped)', conv?.subject === 'RPG Clearance', conv?.subject);
  check('conversation marked unread + OPEN', conv?.unread === true && conv?.status === 'OPEN');
  check('message body stored verbatim (§90)', conv?.messages[0]?.plainTextBody === 'I have completed the RPG.');
  check('threading headers stored', conv?.messages[0]?.inReplyTo === ourMessageId);

  const rec = await prisma.record.findUniqueOrThrow({ where: { id: record.id } });
  check('record.replyReceived set (§14)', rec.replyReceived === true && rec.unreadReply === true);
  check('record.gmailThreadId set', rec.gmailThreadId === threadId);
  check('record business data untouched', (rec.data as any).Email === studentEmail);

  const hist = await prisma.recipientHistory.findMany({ where: { contactId: contact.id, type: 'REPLY' } });
  check('recipient timeline has a REPLY entry (§61)', hist.length === 1);
  const notif = await prisma.notification.findFirst({ where: { workspaceId: workspace.id, type: 'NEW_REPLY' } });
  check('NEW_REPLY notification created (§87)', !!notif && notif.link === `/inbox/${conv?.id}`);

  // ── 2. Idempotency ──
  console.log('\n-- Idempotency (§48) --');
  const r2 = await ingestInboundMessage(account, reply);
  check('same Gmail message again -> DUPLICATE', r2.status === 'DUPLICATE');
  const count = await prisma.conversationMessage.count({ where: { conversationId: conv!.id } });
  check('still exactly one message stored', count === 1, count);

  // ── 3. Second message, same thread ──
  console.log('\n-- Same thread accumulates --');
  const r3 = await ingestInboundMessage(account, parseGmailMessage(gmailMsg({
    id: `reply2-${stamp}`, threadId, from: studentEmail, to: user.email, subject: 'Re: RPG Clearance',
    messageId: `<r2-${stamp}@example.com>`, inReplyTo: `<r1-${stamp}@example.com>`, text: 'Thank you.',
  })));
  check('second message STORED into the same conversation', r3.status === 'STORED' && r3.conversationId === conv!.id && !r3.created);
  const conv2 = await prisma.conversation.findUniqueOrThrow({ where: { id: conv!.id } });
  check('messageCount is 2', conv2.messageCount === 2, conv2.messageCount);

  // ── 4. Bounce is stored but never counts as a reply ──
  console.log('\n-- Bounce handling (§55) --');
  const freshRecord = await prisma.record.create({ data: { datasetId: dataset.id, contactId: contact.id, data: { Email: studentEmail } } });
  const bounceThread = `thread-bounce-${stamp}`;
  await prisma.conversation.create({
    data: { organizationId: org.id, workspaceId: workspace.id, ownerId: user.id, contactId: contact.id, recipientEmail: studentEmail, subject: 'Bounce', emailProviderAccountId: account.id, gmailThreadId: bounceThread },
  });
  await prisma.record.update({ where: { id: freshRecord.id }, data: { replyReceived: false, unreadReply: false } });
  await prisma.record.updateMany({ where: { contactId: contact.id }, data: { replyReceived: false, unreadReply: false } });
  // Two human replies above already produced two notifications; the test is
  // that the bounce adds none, so compare before/after rather than assuming
  // an absolute count.
  const notifBefore = await prisma.notification.count({ where: { workspaceId: workspace.id, type: 'NEW_REPLY' } });
  const r4 = await ingestInboundMessage(account, parseGmailMessage(gmailMsg({
    id: `bounce-${stamp}`, threadId: bounceThread, from: 'mailer-daemon@googlemail.com', to: user.email,
    subject: 'Delivery Status Notification (Failure)', messageId: `<b-${stamp}@google.com>`, text: 'Address not found',
  })));
  check('bounce is STORED', r4.status === 'STORED' && r4.classification === 'BOUNCE', r4);
  const afterBounce = await prisma.record.findUniqueOrThrow({ where: { id: freshRecord.id } });
  check('bounce does NOT set replyReceived', afterBounce.replyReceived === false);
  const bounceConv = await prisma.conversation.findUniqueOrThrow({ where: { emailProviderAccountId_gmailThreadId: { emailProviderAccountId: account.id, gmailThreadId: bounceThread } } });
  check('bounce does NOT mark conversation unread', bounceConv.unread === false);
  const bounceNotif = await prisma.notification.count({ where: { workspaceId: workspace.id, type: 'NEW_REPLY' } });
  check('bounce does NOT create a NEW_REPLY notification', bounceNotif === notifBefore, { before: notifBefore, after: bounceNotif });

  // ── 5. Unrelated mail is ignored ──
  console.log('\n-- Scope (§104) --');
  const r5 = await ingestInboundMessage(account, parseGmailMessage(gmailMsg({
    id: `spam-${stamp}`, threadId: `thread-unrelated-${stamp}`, from: `stranger-${stamp}@nowhere.example`, to: user.email,
    subject: 'Buy now', messageId: `<s-${stamp}@nowhere.example>`, text: 'offer',
  })));
  check('unknown sender, unknown thread, no references -> IGNORED', r5.status === 'IGNORED', r5);
  const r6 = await ingestInboundMessage(account, parseGmailMessage(gmailMsg({
    id: `own-${stamp}`, threadId, from: user.email, to: studentEmail, subject: 'RPG', messageId: `<o-${stamp}@x>`, text: 'x', labels: ['SENT'],
  })));
  check('our own outbound copy -> OUTBOUND_ALREADY_RECORDED', r6.status === 'OUTBOUND_ALREADY_RECORDED', r6);
  const r7 = await ingestInboundMessage(account, parseGmailMessage(gmailMsg({
    id: `unsolicited-${stamp}`, threadId: `thread-new-${stamp}`, from: studentEmail, to: user.email,
    subject: 'Question', messageId: `<q-${stamp}@example.com>`, text: 'Can I get an extension?',
  })));
  check('unsolicited mail from a KNOWN contact -> STORED as a new conversation', r7.status === 'STORED' && r7.created, r7);

  // ── 6. syncAccount with a fake Gmail source ──
  console.log('\n-- syncAccount (§48) --');
  const fresh = await prisma.emailProviderAccount.update({ where: { id: account.id }, data: { gmailHistoryId: '1000' } });
  const m1 = gmailMsg({ id: `sync1-${stamp}`, threadId, from: studentEmail, to: user.email, subject: 'Re: RPG Clearance', messageId: `<s1-${stamp}@example.com>`, inReplyTo: ourMessageId, text: 'via sync' });
  const source: GmailSource = {
    listHistory: async (start) => { check('history path used with stored cursor', start === '1000', start); return { messageIds: [m1.id!, 'gone-id'], historyId: '2000' }; },
    listRecentInbox: async () => ({ messageIds: [], historyId: '9999' }),
    getMessage: async (id) => (id === m1.id ? m1 : null),
    getProfileHistoryId: async () => '2000',
  };
  const s1 = await syncAccount(fresh, source);
  check('sync took the history path', s1.path === 'history', s1.path);
  check('sync stored the new message', s1.stored === 1, s1);
  check('a message deleted between list and fetch is skipped, not an error', s1.errors.length === 0, s1.errors);
  const afterSync = await prisma.emailProviderAccount.findUniqueOrThrow({ where: { id: account.id } });
  check('historyId advanced to 2000', afterSync.gmailHistoryId === '2000', afterSync.gmailHistoryId);

  const goneSource: GmailSource = {
    listHistory: async () => { throw new GmailHistoryGone(); },
    listRecentInbox: async () => ({ messageIds: [], historyId: '3000' }),
    getMessage: async () => null,
    getProfileHistoryId: async () => '3000',
  };
  const s2 = await syncAccount(afterSync, goneSource);
  check('expired history falls back to scan (§105)', s2.path === 'scan', s2.path);
  const afterScan = await prisma.emailProviderAccount.findUniqueOrThrow({ where: { id: account.id } });
  check('cursor advanced after scan', afterScan.gmailHistoryId === '3000', afterScan.gmailHistoryId);

  // ── Cleanup ──
  console.log('\n-- Cleanup --');
  await prisma.notification.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.recipientHistory.deleteMany({ where: { contactId: contact.id } });
  await prisma.conversationMessage.deleteMany({ where: { conversation: { workspaceId: workspace.id } } });
  await prisma.conversation.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.emailJob.deleteMany({ where: { campaignId: campaign.id } });
  await prisma.batch.deleteMany({ where: { campaignId: campaign.id } });
  await prisma.campaign.delete({ where: { id: campaign.id } });
  await prisma.templateVersion.deleteMany({ where: { templateId: template.id } });
  await prisma.template.delete({ where: { id: template.id } });
  await prisma.record.deleteMany({ where: { datasetId: dataset.id } });
  await prisma.datasetColumn.deleteMany({ where: { datasetId: dataset.id } });
  await prisma.dataset.delete({ where: { id: dataset.id } });
  await prisma.contact.delete({ where: { id: contact.id } });
  await prisma.emailProviderAccount.delete({ where: { id: account.id } });
  await prisma.auditLog.deleteMany({ where: { actorId: user.id } });
  await prisma.workspaceMember.deleteMany({ where: { userId: user.id } });
  await prisma.workspace.delete({ where: { id: workspace.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log('  ✓ all inbox-test rows removed');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('INBOX SMOKE TEST CRASHED:', e); process.exit(1); }).finally(() => prisma.$disconnect());
