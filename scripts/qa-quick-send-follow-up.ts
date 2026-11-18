/**
 * QA of the Quick Send follow-up against the REAL database (the laptop standby), with throwaway
 * fixtures in their own organization, and NOTHING sent: the queue runs with a fake Gmail.
 * Covers the chain (replies, opens, bounces, suppression), the follow-up table, mailbox/thread
 * planning, the real startCampaignSend rows, threading headers, wait / fall back when a mailbox is
 * paused, a reply that arrives after the follow-up was prepared, and round 3.
 *
 * Usage: npx tsx scripts/qa-quick-send-follow-up.ts
 */
import 'dotenv/config';
process.env.EMAIL_SEND_GAP_MS = '0';
process.env.EMAIL_RATE_LIMIT_PER_MINUTE = '100000';
delete process.env.REDIS_URL;

import { ColumnType, Role } from '@prisma/client';
import { prisma } from '../lib/db/client';
import { chainCandidates, followUpTable, planFollowUpJobs, planSummary } from '../lib/quickSend/followUp';
import { inSegments, segmentCounts, NOT_REPLIED_SEGMENTS, FOLLOW_UP_SEGMENTS, type FollowUpSegment } from '../lib/recruiterSend/followUp';
import { columnsFromTable } from '../lib/quickSend/prepare';
import { loadCampaignForSession } from '../lib/campaigns/context';
import { startCampaignSend } from '../lib/campaigns/startSend';
import { drainBatch } from '../lib/queue/drain';
import { linkContactsForDataset } from '../lib/records/contactLink';
import { updateOrgSettings } from '../lib/settings/org';
import { QUICK_SEND_DESCRIPTION } from '../lib/quickSend/stats';
import type { AppSession } from '../lib/auth/session';
import type { EmailProvider, SendEmailInput } from '../lib/email/provider';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass++; console.log(`  PASS ${name}`); } else { fail++; failures.push(name); console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''); }
}
const sorted = (a: string[]) => [...a].sort();
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const stamp = Date.now();
const DOMAIN = `qsfu-qa-${stamp}.test`;
let orgId = '';

async function cleanup(id: string) {
  const wss = (await prisma.workspace.findMany({ where: { organizationId: id }, select: { id: true } })).map((w) => w.id);
  const campaigns = (await prisma.campaign.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((c) => c.id);
  await prisma.emailTrackingEvent.deleteMany({ where: { campaignId: { in: campaigns } } });
  const convs = (await prisma.conversation.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((c) => c.id);
  await prisma.conversationMessage.deleteMany({ where: { conversationId: { in: convs } } });
  await prisma.recipientHistory.deleteMany({ where: { contact: { workspaceId: { in: wss } } } }).catch(() => undefined);
  await prisma.conversation.deleteMany({ where: { id: { in: convs } } });
  await prisma.emailJob.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.batch.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.campaign.deleteMany({ where: { id: { in: campaigns } } });
  const templates = (await prisma.template.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((t) => t.id);
  await prisma.templateVersion.deleteMany({ where: { templateId: { in: templates } } });
  await prisma.template.deleteMany({ where: { id: { in: templates } } });
  await prisma.dataset.deleteMany({ where: { workspaceId: { in: wss } } });
  await prisma.contact.deleteMany({ where: { workspaceId: { in: wss } } });
  await prisma.emailSuppression.deleteMany({ where: { workspaceId: { in: wss } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: id } });
  await prisma.integrationSettings.deleteMany({ where: { organizationId: id } });
  await prisma.emailProviderAccount.deleteMany({ where: { organizationId: id } });
  await prisma.workspace.deleteMany({ where: { organizationId: id } });
  await prisma.user.deleteMany({ where: { organizationId: id } });
  await prisma.organization.delete({ where: { id } });
}

let fakeSeq = 0;
function fakeGmail() {
  const sent: { from: string; to: string; subject: string; threadId?: string | null; inReplyTo?: string | null; references?: string | null }[] = [];
  const factory = (account: { emailAddress: string }): EmailProvider => ({
    name: 'fake',
    async sendEmail(input: SendEmailInput) {
      const n = ++fakeSeq;
      sent.push({ from: account.emailAddress, to: input.to, subject: input.subject, threadId: input.threadId, inReplyTo: input.inReplyTo, references: input.references });
      return { providerMessageId: `gm-${stamp}-${n}`, threadId: input.threadId ?? `T-new-${stamp}-${n}`, messageIdHeader: `<fake-${stamp}-${n}@qa>` };
    },
  });
  return { sent, factory };
}

async function main() {
  console.log('=== Quick Send follow-up QA (real DB, nothing sent) ===\n');
  const org = await prisma.organization.create({ data: { name: `QSFU QA ${stamp}`, allowedDomain: DOMAIN } });
  orgId = org.id;
  const mkUser = (tag: string) => prisma.user.create({ data: { organizationId: org.id, googleId: `qsfu-${tag}-${stamp}`, email: `qsfu-${tag}+${stamp}@${DOMAIN}`, name: `QSFU ${tag}`, role: Role.ADMIN } });
  const admin = await mkUser('admin');
  const mate = await mkUser('mate');
  const stranger = await mkUser('stranger');
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: `QSFU ws ${stamp}` } });
  const wsMate = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: mate.id, name: `QSFU mate ${stamp}` } });
  const wsStranger = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: stranger.id, name: `QSFU stranger ${stamp}` } });
  const acct = (workspaceId: string, userId: string, tag: string) => prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId, userId, emailAddress: `${tag}-${stamp}@${DOMAIN}`, displayName: tag, status: 'CONNECTED', refreshTokenEnc: 'x' } });
  const A1 = await acct(ws.id, admin.id, 'one'); // the admin's own mailbox
  const A2 = await acct(wsMate.id, mate.id, 'two'); // a teammate's shared backup
  const A3 = await acct(wsStranger.id, stranger.id, 'three'); // a teammate who has NOT shared theirs
  await updateOrgSettings(org.id, { fallbackMailboxes: [A2.id] }, admin.id);
  const session: AppSession = { userId: admin.id, organizationId: org.id, workspaceId: ws.id, homeWorkspaceId: ws.id, role: Role.ADMIN, status: 'ACTIVE', email: admin.email, name: admin.name };

  // ───────── The first Quick Send (finished): 9 people ─────────
  const dataset = await prisma.dataset.create({
    data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: `Quick send · root`, columns: { create: [{ key: 'Name', label: 'Name', type: ColumnType.TEXT, order: 1 }, { key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 2 }, { key: 'Company', label: 'Company', type: ColumnType.TEXT, order: 3 }] } },
  });
  const template = await prisma.template.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: 'Quick send · root', description: QUICK_SEND_DESCRIPTION } });
  const version = await prisma.templateVersion.create({ data: { templateId: template.id, version: 1, subject: 'Hello {{Name}}', html: '<p>Hello {{Name}}, original</p>', plainText: 'Hello', variables: ['Name'], createdById: admin.id } });
  const root = await prisma.campaign.create({ data: { organizationId: org.id, workspaceId: ws.id, name: 'QA root send', description: QUICK_SEND_DESCRIPTION, datasetId: dataset.id, templateId: template.id, templateVersionId: version.id, createdById: admin.id, status: 'COMPLETED', senderAccountId: A1.id } });
  const rootBatch = await prisma.batch.create({ data: { campaignId: root.id, label: `BATCH-QA-${stamp}`, status: 'COMPLETED', total: 9, validCount: 9, sentCount: 8 } });
  const em = (n: string) => `${n}+${stamp}@gmail.com`;
  type P = { n: string; account: typeof A1; opened?: boolean; replied?: boolean; bounced?: boolean; suppressed?: boolean; failed?: boolean };
  const people: P[] = [
    { n: 'q1', account: A1, replied: true }, { n: 'q2', account: A1, opened: true }, { n: 'q3', account: A1 }, { n: 'q4', account: A1 },
    { n: 'q5', account: A1, bounced: true }, { n: 'q6', account: A1, suppressed: true }, { n: 'q7', account: A2 }, { n: 'q8', account: A1 }, { n: 'q9', account: A1, failed: true },
  ];
  const contacts = new Map<string, string>();
  const jobIds = new Map<string, string>();
  for (const [i, p] of people.entries()) {
    const rec = await prisma.record.create({ data: { datasetId: dataset.id, data: { Name: p.n.toUpperCase(), Email: em(p.n), Company: `Co ${p.n}` } } });
    const job = await prisma.emailJob.create({
      data: {
        batchId: rootBatch.id, campaignId: root.id, recordId: rec.id, templateVersionId: version.id, emailProviderAccountId: p.account.id, status: p.failed ? 'FAILED' : 'SENT', toEmail: em(p.n),
        fromName: p.account.displayName ?? 'x', fromEmail: p.account.emailAddress, subject: `Hello ${p.n.toUpperCase()}`, html: '<p>Hello</p>', sentAt: p.failed ? null : new Date(Date.now() - 3 * 864e5 + i),
        gmailThreadId: p.failed ? null : `QT-${p.n}`, messageIdHeader: p.failed ? null : `<q-${p.n}@x>`, errorCode: p.bounced ? 'BOUNCED' : p.failed ? 'UNKNOWN' : null,
      },
    });
    jobIds.set(p.n, job.id);
    if (p.opened) await prisma.emailTrackingEvent.create({ data: { campaignId: root.id, emailJobId: job.id, email: em(p.n), type: 'OPEN', automated: false } });
    if (p.suppressed) await prisma.emailSuppression.create({ data: { workspaceId: ws.id, email: em(p.n), reason: 'UNSUBSCRIBED', source: 'QA' } });
    if (p.replied) {
      const c = await prisma.contact.create({ data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: em(p.n), name: p.n } });
      contacts.set(p.n, c.id);
      const conv = await prisma.conversation.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, contactId: c.id, recipientEmail: em(p.n), subject: 'Re: Hello', emailProviderAccountId: p.account.id, gmailThreadId: `QT-${p.n}`, firstMessageAt: new Date(Date.now() - 2 * 864e5), lastMessageAt: new Date(Date.now() - 2 * 864e5), messageCount: 1 } });
      await prisma.conversationMessage.create({ data: { conversationId: conv.id, gmailThreadId: `QT-${p.n}`, direction: 'INBOUND', classification: 'HUMAN_REPLY', senderEmail: em(p.n), recipientEmail: p.account.emailAddress, cc: [], bcc: [], sentAt: new Date(Date.now() - 2 * 864e5), status: 'RECEIVED' } });
    }
  }
  // A Gmail "slow down" marker we can switch on for a mailbox: a failed job in the root campaign.
  const dummyRec = await prisma.record.create({ data: { datasetId: dataset.id, data: { Name: 'D', Email: em('dummy'), Company: 'D' } } });
  const blockMailbox = (accountId: string) => prisma.emailJob.create({ data: { batchId: rootBatch.id, campaignId: root.id, recordId: dummyRec.id, templateVersionId: version.id, emailProviderAccountId: accountId, status: 'FAILED', toEmail: em('dummy'), fromName: 'x', fromEmail: 'x@x.test', subject: 's', html: '<p/>', errorCode: 'RATE_LIMIT', lastAttemptAt: new Date() } });
  const unblock = (id: string) => prisma.emailJob.delete({ where: { id } });

  console.log('The chain');
  const cands = await chainCandidates(root.id, ws.id);
  check('candidates are only people who were actually sent an email (not the failed one)', eq(sorted(cands.map((c) => c.email)), sorted(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'].map(em))), cands.map((c) => c.email));
  const counts = segmentCounts(cands);
  check('counts: opened 1, not opened 4 (q3 q4 q7 q8), replied 1, bounced/suppressed 2, total 8', eq(counts, { NO_REPLY_OPENED: 1, NO_REPLY_UNOPENED: 4, NO_REPLY_UNKNOWN: 0, REPLIED: 1, bounced: 2, total: 8 }), counts);
  const byEmail = new Map(cands.map((c) => [c.email, c]));
  check('a bounced send and a suppressed address are both "never included"', byEmail.get(em('q5'))?.bounced === true && byEmail.get(em('q6'))?.suppressed === true);
  check('people keep their list columns by label (Name, Company)', byEmail.get(em('q3'))?.data.Company === 'Co q3' && byEmail.get(em('q3'))?.data.Name === 'Q3', byEmail.get(em('q3'))?.data);
  check('each candidate knows the mailbox of their last email', byEmail.get(em('q7'))?.sourceAccountId === A2.id && byEmail.get(em('q3'))?.sourceAccountId === A1.id);
  const pickEmails = (segs: readonly FollowUpSegment[]) => cands.filter((c) => inSegments(c, segs)).map((c) => c.email);
  check('"not replied" = q2, q3, q4, q7, q8 (5)', pickEmails(NOT_REPLIED_SEGMENTS).length === 5, pickEmails(NOT_REPLIED_SEGMENTS));
  check('everything ticked = 6 (bounced and suppressed never included)', pickEmails([...FOLLOW_UP_SEGMENTS]).length === 6);
  check('only opened = q2; only replied = q1', eq(pickEmails(['NO_REPLY_OPENED']), [em('q2')]) && eq(pickEmails(['REPLIED']), [em('q1')]));
  check('without a workspace the suppression list is not asked, with one it is', (await chainCandidates(root.id, '')).every((c) => !c.suppressed) && (await chainCandidates(root.id, ws.id)).some((c) => c.suppressed));
  check('another workspace gets no flags from this one’s list', (await chainCandidates(root.id, wsStranger.id)).every((c) => !c.suppressed));

  console.log('\nThe follow-up table');
  const tbl = await followUpTable({ workspaceId: ws.id, parentCampaignId: root.id, emails: [em('Q3').toUpperCase(), em('q4'), `extra+${stamp}@gmail.com`, em('q3')] });
  check('the table has the original columns, one row per person (de-duplicated, any case)', !('error' in tbl) && eq(tbl.headers, ['Name', 'Email', 'Company']) && tbl.rows.length === 3 && tbl.emailHeader === 'Email', 'error' in tbl ? tbl.error : tbl.rows);
  check('known people keep their values; a new address has only its email', !('error' in tbl) && tbl.rows[0]!.Company === 'Co q3' && tbl.rows[2]!.Company === '' && tbl.rows[2]!.Email === `extra+${stamp}@gmail.com`);
  check('a send that is not finished can not be followed up', 'error' in (await followUpTable({ workspaceId: ws.id, parentCampaignId: (await prisma.campaign.create({ data: { organizationId: org.id, workspaceId: ws.id, name: 'running', datasetId: dataset.id, templateId: template.id, templateVersionId: version.id, createdById: admin.id, status: 'RUNNING' } })).id, emails: [em('q3')] })));
  check('another workspace can not follow up this send', 'error' in (await followUpTable({ workspaceId: wsStranger.id, parentCampaignId: root.id, emails: [em('q3')] })));
  check('an unknown send is refused', 'error' in (await followUpTable({ workspaceId: ws.id, parentCampaignId: 'nope', emails: [em('q3')] })));

  console.log('\nPlanning (mailbox and thread per person)');
  const sender = { id: A1.id, emailAddress: A1.emailAddress, displayName: A1.displayName };
  const emails5 = pickEmails(NOT_REPLIED_SEGMENTS);
  const wait = await planFollowUpJobs({ rootCampaignId: root.id, organizationId: org.id, onMailboxDown: 'WAIT', sender, emails: emails5 });
  check('everyone replies in their own thread (5)', planSummary(wait).replying === 5 && planSummary(wait).newThread === 0 && planSummary(wait).blocked.length === 0, planSummary(wait));
  check('q7 is pinned to the shared teammate mailbox, the rest to the admin’s', wait.get(em('q7'))?.accountId === A2.id && wait.get(em('q3'))?.accountId === A1.id && wait.get(em('q3'))?.replyThreadId === 'QT-q3' && wait.get(em('q3'))?.inReplyToJobId === jobIds.get('q3'));
  const mixed = await planFollowUpJobs({ rootCampaignId: root.id, organizationId: org.id, onMailboxDown: 'WAIT', sender, emails: [...emails5, `new+${stamp}@gmail.com`] });
  check('a new address starts its own thread from the sender', mixed.get(`new+${stamp}@gmail.com`)?.replyThreadId === null && mixed.get(`new+${stamp}@gmail.com`)?.accountId === A1.id && planSummary(mixed).newThread === 1);
  const otherSender = { id: A3.id, emailAddress: A3.emailAddress, displayName: A3.displayName };
  const blockedPlan = await planFollowUpJobs({ rootCampaignId: root.id, organizationId: org.id, onMailboxDown: 'WAIT', sender: otherSender, emails: emails5 });
  check('WAIT by someone who may not use the admin’s mailbox is blocked, naming it (the shared teammate mailbox is fine for q7)', eq(planSummary(blockedPlan).blocked, [A1.emailAddress]) && planSummary(blockedPlan).replying === 1, planSummary(blockedPlan));
  const fallbackPlan = await planFollowUpJobs({ rootCampaignId: root.id, organizationId: org.id, onMailboxDown: 'FALLBACK', sender: otherSender, emails: emails5 });
  check('FALLBACK by that person: what they can’t reply from goes out from their own mailbox as a new thread; q7 still replies in its thread', planSummary(fallbackPlan).newThread === 4 && planSummary(fallbackPlan).replying === 1 && fallbackPlan.get(em('q3'))?.accountId === A3.id && fallbackPlan.get(em('q3'))?.replyThreadId === null && fallbackPlan.get(em('q7'))?.accountId === A2.id, planSummary(fallbackPlan));

  // ───────── Round 2: what POST /api/quick-send writes, then startCampaignSend ─────────
  async function makeFollowUp(parent: { id: string; round: number }, rootId: string, emails: string[], over: { onMailboxDown?: string; fallbackAccountIds?: string[] } = {}, extraRows: Record<string, string>[] = []) {
    const t = await followUpTable({ workspaceId: ws.id, parentCampaignId: parent.id, emails });
    if ('error' in t) throw new Error(t.error);
    const rows = [...t.rows, ...extraRows];
    const columns = columnsFromTable({ headers: t.headers, rows }, t.emailHeader);
    const ds = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: `Quick send · follow-up ${parent.round + 1}`, columns: { create: columns.map((c, i) => ({ key: c.key, label: c.label, type: c.type, order: i + 1 })) } } });
    await prisma.record.createMany({ data: rows.map((r) => ({ datasetId: ds.id, data: Object.fromEntries(columns.map((c) => [c.key, r[c.header] ?? ''])) })) });
    await linkContactsForDataset({ organizationId: org.id, workspaceId: ws.id, datasetId: ds.id });
    const tpl = await prisma.template.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: `Quick send · fu ${parent.round + 1}`, description: QUICK_SEND_DESCRIPTION } });
    const v = await prisma.templateVersion.create({ data: { templateId: tpl.id, version: 1, subject: 'Re: Hello {{Name}}', html: '<p>Hello {{Name}}, a quick follow-up</p>', plainText: 'Hello', variables: ['Name'], createdById: admin.id } });
    return prisma.campaign.create({
      data: {
        organizationId: org.id, workspaceId: ws.id, name: `QA follow-up ${parent.round + 1}`, description: QUICK_SEND_DESCRIPTION, datasetId: ds.id, templateId: tpl.id, templateVersionId: v.id, createdById: admin.id, status: 'DRAFT',
        parentCampaignId: parent.id, rootCampaignId: rootId, round: parent.round + 1, followUpAudience: 'NO_REPLY_OPENED,NO_REPLY_UNOPENED', onMailboxDown: over.onMailboxDown ?? 'WAIT', fallbackAccountIds: over.fallbackAccountIds ?? [],
      },
    });
  }
  const start = async (campaignId: string) => {
    const campaign = (await loadCampaignForSession(session, campaignId))!;
    const res = await startCampaignSend({ campaign, actor: session, skipApproval: true, via: 'qa' });
    const jobs = await prisma.emailJob.findMany({ where: { campaignId }, select: { id: true, toEmail: true, status: true, emailProviderAccountId: true, fromEmail: true, replyThreadId: true, inReplyToJobId: true, skipReason: true, batchId: true } });
    return { res, jobs, batchId: jobs[0]?.batchId ?? (res.ok ? (res.body.batch as { id: string }).id : '') };
  };

  console.log('\nRound 2: start and send');
  const f2 = await makeFollowUp({ id: root.id, round: 1 }, root.id, emails5);
  const s2 = await start(f2.id);
  check('start accepted: 5 jobs queued', s2.res.ok && s2.jobs.length === 5 && s2.jobs.every((j) => j.status === 'QUEUED'), s2.res.ok ? s2.jobs.length : s2.res.body);
  const j2 = new Map(s2.jobs.map((j) => [j.toEmail, j]));
  check('each job replies to the right earlier email and thread', j2.get(em('q3'))?.replyThreadId === 'QT-q3' && j2.get(em('q3'))?.inReplyToJobId === jobIds.get('q3') && j2.get(em('q2'))?.replyThreadId === 'QT-q2', [...j2.values()].map((j) => [j.toEmail, j.replyThreadId]));
  check('q7’s job is queued from the teammate’s mailbox, the others from the admin’s', j2.get(em('q7'))?.emailProviderAccountId === A2.id && j2.get(em('q7'))?.fromEmail === A2.emailAddress && j2.get(em('q3'))?.emailProviderAccountId === A1.id);

  // A reply arrives after the follow-up was prepared (q4) → skipped when its turn comes.
  const conv4 = await prisma.conversation.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, contactId: (await prisma.contact.upsert({ where: { workspaceId_primaryEmail: { workspaceId: ws.id, primaryEmail: em('q4') } }, create: { organizationId: org.id, workspaceId: ws.id, primaryEmail: em('q4') }, update: {} })).id, recipientEmail: em('q4'), subject: 'Re: Hello', emailProviderAccountId: A1.id, gmailThreadId: 'QT-q4', firstMessageAt: new Date(), lastMessageAt: new Date(), messageCount: 1 } });
  await prisma.conversationMessage.create({ data: { conversationId: conv4.id, gmailThreadId: 'QT-q4', direction: 'INBOUND', classification: 'HUMAN_REPLY', senderEmail: em('q4'), recipientEmail: A1.emailAddress, cc: [], bcc: [], sentAt: new Date(Date.now() + 1000), status: 'RECEIVED' } });
  // The teammate's mailbox is paused by Gmail: q7 (WAIT) must wait, everyone else goes.
  const block = await blockMailbox(A2.id);
  const gm2 = fakeGmail();
  const d2 = await drainBatch(s2.batchId, { limit: 50, providerFactory: gm2.factory as never });
  const sentTo = gm2.sent.map((m) => m.to);
  check('WAIT: q2, q3, q8 are sent; q7 (paused mailbox) is not; q4 (replied meanwhile) is not', eq(sorted(sentTo), sorted([em('q2'), em('q3'), em('q8')])), sentTo);
  const q3msg = gm2.sent.find((m) => m.to === em('q3'));
  check('each goes into its own thread with In-Reply-To and References, from the admin’s mailbox', q3msg?.threadId === 'QT-q3' && q3msg?.inReplyTo === '<q-q3@x>' && q3msg?.references === '<q-q3@x>' && q3msg?.from === A1.emailAddress, q3msg);
  const after = await prisma.emailJob.findMany({ where: { campaignId: f2.id }, select: { toEmail: true, status: true, skipReason: true } });
  const st = new Map(after.map((j) => [j.toEmail, j]));
  check('q7 is still queued (waiting); the others were not held up behind it', st.get(em('q7'))?.status === 'QUEUED' && d2.remaining === 1 && d2.sent === 3, { d2, q7: st.get(em('q7')) });
  const dHold = await drainBatch(s2.batchId, { limit: 50, providerFactory: fakeGmail().factory as never });
  check('the next pass sends nothing and reports the batch on hold (backoff), not finished', dHold.sent === 0 && dHold.heldReason === 'backoff' && dHold.remaining === 1, dHold);
  check('q4 is skipped with a clear reason and never emailed', st.get(em('q4'))?.status === 'SKIPPED' && /Replied after/.test(st.get(em('q4'))?.skipReason ?? ''), st.get(em('q4')));
  await unblock(block.id);
  const gm2b = fakeGmail();
  const d2b = await drainBatch(s2.batchId, { limit: 50, providerFactory: gm2b.factory as never });
  check('WAIT: when the mailbox is back, q7 goes out in its own thread from that mailbox and the batch finishes', eq(gm2b.sent.map((m) => [m.to, m.from, m.threadId]), [[em('q7'), A2.emailAddress, 'QT-q7']]) && d2b.remaining === 0, { sent: gm2b.sent, d2b });
  const f2done = await prisma.campaign.update({ where: { id: f2.id }, data: { status: 'COMPLETED' } });

  // ───────── Round 3 ─────────
  console.log('\nRound 3');
  const c3 = await chainCandidates(root.id, ws.id);
  const c3by = new Map(c3.map((c) => [c.email, c]));
  check('q4 replied in round 2, so they are now "replied"', c3by.get(em('q4'))?.replied === true);
  const r2job3 = (await prisma.emailJob.findFirst({ where: { campaignId: f2.id, toEmail: em('q3') } }))!;
  check('q3’s latest email is now the round-2 one, in the same thread', c3by.get(em('q3'))?.sourceJobId === r2job3.id && c3by.get(em('q3'))?.sourceCampaignId === f2.id);
  const emails3 = c3.filter((c) => inSegments(c, NOT_REPLIED_SEGMENTS)).map((c) => c.email);
  check('round 3 targets only those who still have not replied (q2, q3, q7, q8)', eq(sorted(emails3), sorted(['q2', 'q3', 'q7', 'q8'].map(em))), emails3);
  const f3 = await makeFollowUp({ id: f2done.id, round: 2 }, root.id, emails3);
  const s3 = await start(f3.id);
  const gm3 = fakeGmail();
  await drainBatch(s3.batchId, { limit: 50, providerFactory: gm3.factory as never });
  const m3 = gm3.sent.find((m) => m.to === em('q3'));
  const r2q3 = (await prisma.emailJob.findFirst({ where: { campaignId: f2.id, toEmail: em('q3') }, select: { messageIdHeader: true } }))!;
  check('round 3 replies to the round-2 message, with the whole References chain', m3?.threadId === 'QT-q3' && m3?.inReplyTo === r2q3.messageIdHeader && m3?.references === `<q-q3@x> ${r2q3.messageIdHeader}`, m3);

  // ───────── FALLBACK ─────────
  console.log('\nFALLBACK when a mailbox is paused');
  const A4 = await acct((await prisma.workspace.create({ data: { organizationId: org.id, ownerId: (await mkUser('backup')).id, name: `QSFU backup ${stamp}` } })).id, (await prisma.user.findFirstOrThrow({ where: { email: { startsWith: 'qsfu-backup' }, organizationId: org.id } })).id, 'four');
  await updateOrgSettings(org.id, { fallbackMailboxes: [A2.id, A4.id] }, admin.id);
  const f4parent = await prisma.campaign.update({ where: { id: f3.id }, data: { status: 'COMPLETED' } });
  const emails4 = [em('q7'), em('q8')];
  const f4 = await makeFollowUp({ id: f4parent.id, round: 3 }, root.id, emails4, { onMailboxDown: 'FALLBACK', fallbackAccountIds: [A4.id] });
  const s4 = await start(f4.id);
  const block2 = await blockMailbox(A2.id);
  const gm4 = fakeGmail();
  const d4 = await drainBatch(s4.batchId, { limit: 50, providerFactory: gm4.factory as never });
  const q7 = gm4.sent.find((m) => m.to === em('q7'));
  const q8 = gm4.sent.find((m) => m.to === em('q8'));
  check('FALLBACK: q7 (paused mailbox) is sent at once from the backup mailbox as a NEW thread (no threadId / In-Reply-To)', q7?.from === A4.emailAddress && !q7?.threadId && !q7?.inReplyTo, q7);
  check('FALLBACK: q8 (healthy mailbox) still replies in its thread', q8?.from === A1.emailAddress && !!q8?.threadId && !!q8?.inReplyTo, q8);
  check('FALLBACK: nothing is left queued', d4.remaining === 0, d4);
  await unblock(block2.id);

  // ───────── Guard on the route-level rule: one follow-up at a time ─────────
  console.log('\nOne follow-up at a time');
  const open = await prisma.campaign.findFirst({ where: { parentCampaignId: root.id, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'RUNNING', 'PAUSED'] } } });
  check('with every follow-up of the first send finished, none is "open"', !open);
}

main()
  .catch((err) => { fail++; failures.push(`script crashed: ${err instanceof Error ? err.message : String(err)}`); console.error(err); })
  .finally(async () => {
    if (orgId) await cleanup(orgId).catch((e) => console.error('cleanup failed (remove org', orgId, 'by hand):', e.message));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
