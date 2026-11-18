/**
 * QA of Recruiter Follow-up against the REAL database (the laptop standby), with throwaway
 * fixtures in their own organization, and NOTHING sent: the sender runs with a fake Gmail.
 * Covers the chain, the multi-select audience, editing the list, planning/pinning, the start
 * rows, threading, wait / fall back when a mailbox is down, replies across rounds, late
 * unsubscribes, round 3, and the size of a big list.
 *
 * Usage: npx tsx scripts/qa-recruiter-follow-up.ts
 */
import 'dotenv/config';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';
import { applyAudience, addToAudience, chainCandidates, followUpSubject, segmentCounts, parseSegments, NOT_REPLIED_SEGMENTS, FOLLOW_UP_SEGMENTS, type FollowUpSegment } from '../lib/recruiterSend/followUp';
import { planBlast } from '../lib/recruiterSend/plan';
import { runRecruiterWorker, type RecruiterSender } from '../lib/recruiterSend/worker';
import { markRecruiterReplied } from '../lib/recruiterSend/replies';
import { updateOrgSettings } from '../lib/settings/org';

delete process.env.CRON_SECRET; // no hand-over calls
delete process.env.REDIS_URL;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '');
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a: string[]) => [...a].sort();

const stamp = Date.now();
const DOMAIN = `rfu-qa-${stamp}.test`;
let orgId = '';

async function cleanup(id: string) {
  const blasts = (await prisma.recruiterBlast.findMany({ where: { organizationId: id }, select: { id: true } })).map((b) => b.id);
  await prisma.recruiterBlastRecipient.deleteMany({ where: { blastId: { in: blasts } } });
  await prisma.recruiterBlastGroup.deleteMany({ where: { blastId: { in: blasts } } });
  await prisma.recruiterBlast.deleteMany({ where: { id: { in: blasts } } });
  const wss = (await prisma.workspace.findMany({ where: { organizationId: id }, select: { id: true } })).map((w) => w.id);
  await prisma.emailSuppression.deleteMany({ where: { workspaceId: { in: wss } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: id } });
  await prisma.integrationSettings.deleteMany({ where: { organizationId: id } });
  await prisma.emailProviderAccount.deleteMany({ where: { organizationId: id } });
  await prisma.workspace.deleteMany({ where: { organizationId: id } });
  await prisma.user.deleteMany({ where: { organizationId: id } });
  await prisma.organization.delete({ where: { id } });
}

/** A fake Gmail: records every message and answers like Gmail would. */
function fakeGmail() {
  const sent: { from: string; to: string; bcc: string[]; subject: string; threadId?: string | null; inReplyTo?: string | null; references?: string | null; messageId: string }[] = [];
  const send: RecruiterSender = async (account, input) => {
    const n = sent.length + 1;
    const messageId = `<fake-${stamp}-${n}@qa>`;
    sent.push({ from: account.emailAddress, to: input.to, bcc: input.bcc ?? [], subject: input.subject, threadId: input.threadId, inReplyTo: input.inReplyTo, references: input.references, messageId });
    return { providerMessageId: `gm-${stamp}-${n}`, threadId: input.threadId ?? `T-new-${stamp}-${n}`, messageIdHeader: messageId };
  };
  return { sent, send };
}
const run = (send: RecruiterSender) => runRecruiterWorker({ runOn: 'all', send, budgetMs: 60_000, staggerMs: () => 0, sleep: async () => undefined, reserveMs: 0, maxParallel: 10 });

async function main() {
  console.log('=== Recruiter Follow-up QA (real DB, nothing sent) ===\n');
  const org = await prisma.organization.create({ data: { name: `RFU QA ${stamp}`, allowedDomain: DOMAIN } });
  orgId = org.id;
  const user = await prisma.user.create({ data: { organizationId: org.id, googleId: `rfu-${stamp}`, email: `rfu-qa+${stamp}@${DOMAIN}`, name: 'RFU QA', role: Role.ADMIN } });
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: user.id, name: `RFU QA ${stamp}` } });
  const mk = (suffix: string) => prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: user.id, emailAddress: `${suffix}-${stamp}@${DOMAIN}`, displayName: suffix, status: 'CONNECTED', refreshTokenEnc: 'x' } });
  // Only one mailbox per (workspace, user, provider); the second is a teammate's.
  const mate = await prisma.user.create({ data: { organizationId: org.id, googleId: `rfu2-${stamp}`, email: `rfu-mate+${stamp}@${DOMAIN}`, name: 'RFU Mate', role: Role.ADMIN } });
  const a1 = await mk('one');
  const a2 = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: mate.id, emailAddress: `two-${stamp}@${DOMAIN}`, displayName: 'two', status: 'CONNECTED', refreshTokenEnc: 'x' } });
  await updateOrgSettings(org.id, { fallbackMailboxes: [a2.id] }, user.id);

  const email = (n: string) => `${n}@gmail.com`.replace('@gmail.com', `+rfu${stamp}@gmail.com`);
  const base = { organizationId: org.id, workspaceId: ws.id, createdById: user.id, subject: 'Hiring partners', html: '<p>Hi {{Name}}</p>', plainText: 'Hi', body: 'Hi', columns: ['Name', 'Email', 'Company'], emailColumn: 'Email', gapSeconds: 0, ccAddresses: [] as string[], accountLimits: {} };

  // ───────── Chain 1: a BCC send, two mailboxes, 7 recruiters ─────────
  console.log('Chain 1: BCC send, two mailboxes');
  const root = await prisma.recruiterBlast.create({ data: { ...base, name: 'Root BCC', mode: 'BCC', toAddress: `placements@${DOMAIN}`, accountIds: [a1.id, a2.id], status: 'COMPLETED', startedAt: new Date(), completedAt: new Date() } });
  const g1 = await prisma.recruiterBlastGroup.create({ data: { blastId: root.id, seq: 1, status: 'SENT', recipientCount: 4, accountId: a1.id, plannedAccountId: a1.id, fromEmail: a1.emailAddress, gmailThreadId: 'T1', messageIdHeader: '<m1@x>', gmailMessageId: 'gm1', sentAt: new Date(Date.now() - 3 * 864e5) } });
  const g2 = await prisma.recruiterBlastGroup.create({ data: { blastId: root.id, seq: 2, status: 'SENT', recipientCount: 3, accountId: a2.id, plannedAccountId: a2.id, fromEmail: a2.emailAddress, gmailThreadId: 'T2', messageIdHeader: '<m2@x>', gmailMessageId: 'gm2', sentAt: new Date(Date.now() - 3 * 864e5) } });
  const r = (n: string, groupId: string | null, status: string, extra: Record<string, unknown> = {}) => ({ blastId: root.id, email: email(n), name: `Name ${n}`, data: { Name: `Name ${n}`, Email: email(n), Company: `Co ${n}` }, groupId, status, sentAt: status === 'SENT' ? new Date(Date.now() - 3 * 864e5) : null, ...extra });
  await prisma.recruiterBlastRecipient.createMany({
    data: [
      r('r1', g1.id, 'SENT', { repliedAt: new Date() }), // replied
      r('r2', g1.id, 'SENT'),
      r('r3', g1.id, 'BOUNCED', { skipReason: 'address not found' }), // bounced
      r('r4', g1.id, 'SENT'),
      r('r5', g2.id, 'SENT'),
      r('r6', null, 'SKIPPED', { skipReason: 'No value' }), // never sent anything
      r('r7', g2.id, 'SENT'),
    ],
  });

  const c1 = await chainCandidates(root.id);
  check('candidates are only people who were actually sent an email', same(sorted(c1.map((c) => c.email)), sorted(['r1', 'r2', 'r4', 'r5', 'r7'].map(email))), c1.map((c) => c.email));
  check('bounced and never-sent recruiters are not candidates', !c1.some((c) => [email('r3'), email('r6')].includes(c.email)));
  const counts1 = segmentCounts(c1);
  check('BCC round: nobody has known opens, so all non-repliers are "opens unknown"', counts1.NO_REPLY_UNKNOWN === 4 && counts1.NO_REPLY_OPENED === 0 && counts1.NO_REPLY_UNOPENED === 0 && counts1.REPLIED === 1, counts1);

  // ───────── The follow-up draft (what POST /api/recruiter-follow-ups does) ─────────
  async function newFollowUp(parent: { id: string; round: number; rootBlastId: string | null; subject: string }, segs: readonly FollowUpSegment[], over: Record<string, unknown> = {}) {
    const rootId = parent.rootBlastId ?? parent.id;
    const draft = await prisma.recruiterBlast.create({
      data: { ...base, name: `Follow-up ${parent.round}`, mode: 'BCC', toAddress: `placements@${DOMAIN}`, subject: followUpSubject(parent.subject), html: '<p>Just checking in</p>', plainText: 'Just checking in', body: 'Just checking in', accountIds: [a1.id, a2.id], parentBlastId: parent.id, rootBlastId: rootId, round: parent.round + 1, onMailboxDown: 'WAIT', ...over },
    });
    const n = await applyAudience(draft.id, rootId, segs);
    return { draft, n, rootId };
  }
  const f2 = await newFollowUp(root, NOT_REPLIED_SEGMENTS);
  check('default audience = everyone who has not replied (4)', f2.n === 4, f2.n);
  const rowsOf = async (id: string) => (await prisma.recruiterBlastRecipient.findMany({ where: { blastId: id }, select: { email: true, sourceGroupId: true, data: true, status: true } })).sort((a, b) => a.email.localeCompare(b.email));
  const rows2 = await rowsOf(f2.draft.id);
  check('each recruiter keeps the earlier email they got (source group) and their columns', rows2.every((x) => x.sourceGroupId && (x.data as Record<string, string>)?.Company?.startsWith('Co ')), rows2);
  check('saved audience is the three no-reply segments', same(parseSegments((await prisma.recruiterBlast.findUnique({ where: { id: f2.draft.id } }))!.followUpAudience), NOT_REPLIED_SEGMENTS));

  // ───────── Multi-select combinations ─────────
  console.log('\nMulti-select audience');
  check('only "already replied" → just r1', (await applyAudience(f2.draft.id, f2.rootId, ['REPLIED'])) === 1);
  check('replied + unknown → everyone sent (5)', (await applyAudience(f2.draft.id, f2.rootId, ['REPLIED', 'NO_REPLY_UNKNOWN'])) === 5);
  check('opened / not opened on a BCC-only chain → nobody (0), no crash', (await applyAudience(f2.draft.id, f2.rootId, ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED'])) === 0);
  check('nothing ticked → nobody (0)', (await applyAudience(f2.draft.id, f2.rootId, [])) === 0);
  check('all four segments → 5 (bounced never included)', (await applyAudience(f2.draft.id, f2.rootId, [...FOLLOW_UP_SEGMENTS])) === 5);
  check('applying twice does not duplicate rows', (await applyAudience(f2.draft.id, f2.rootId, [...FOLLOW_UP_SEGMENTS])) === 5 && (await rowsOf(f2.draft.id)).length === 5);
  check('duplicate segments in the request are harmless', (await applyAudience(f2.draft.id, f2.rootId, ['NO_REPLY_UNKNOWN', 'NO_REPLY_UNKNOWN'])) === 4);

  // ───────── Editing the list ─────────
  console.log('\nEditing the list');
  const before = (await rowsOf(f2.draft.id)).length;
  const typed = [email('r3').toUpperCase(), `  New.Person+${stamp}@gmail.com `, email('r2'), `new.person+${stamp}@GMAIL.com`];
  const added = await addToAudience(f2.draft.id, f2.rootId, typed);
  const rowsAfterAdd = await rowsOf(f2.draft.id);
  check('a bounced address typed in is never added', !rowsAfterAdd.some((x) => x.email === email('r3')), added);
  check('an address already in the list is not added twice', rowsAfterAdd.filter((x) => x.email === email('r2')).length === 1);
  check('a new address (any case / spaces) is added once, with no earlier thread', rowsAfterAdd.filter((x) => x.email === `new.person+${stamp}@gmail.com`).length === 1 && rowsAfterAdd.find((x) => x.email === `new.person+${stamp}@gmail.com`)!.sourceGroupId === null, added);
  check('exactly one row was added in total', rowsAfterAdd.length === before + 1, { before, now: rowsAfterAdd.length });
  const reAdd = await addToAudience(f2.draft.id, f2.rootId, [email('r1')]);
  check('adding a recruiter who replied back by hand works and keeps their thread', reAdd.added === 1 && (await rowsOf(f2.draft.id)).find((x) => x.email === email('r1'))!.sourceGroupId === g1.id);
  check('adding nothing is a no-op', (await addToAudience(f2.draft.id, f2.rootId, ['  ', ''])).added === 0);

  // ───────── Planning: grouping and pinning ─────────
  console.log('\nPlanning');
  await applyAudience(f2.draft.id, f2.rootId, NOT_REPLIED_SEGMENTS);
  await addToAudience(f2.draft.id, f2.rootId, [`new.person+${stamp}@gmail.com`]);
  const draftRow = async (id: string) => (await prisma.recruiterBlast.findUnique({ where: { id } }))!;
  const plan = await planBlast(await draftRow(f2.draft.id));
  const specs = plan.groupSpecs.map((s) => ({ n: s.ids.length, src: s.sourceGroupId, pin: s.pinnedAccountId }));
  check('BCC: recruiters of the same earlier email stay together; the new address is its own batch', specs.length === 3, specs);
  check('each batch is pinned to the mailbox of its earlier email', specs.find((s) => s.src === g1.id)?.pin === a1.id && specs.find((s) => s.src === g2.id)?.pin === a2.id, specs);
  check('plan says 2 batches continue a thread and 1 starts a new one', plan.followUp?.replying === 2 && plan.followUp?.newThread === 1, plan.followUp);
  check('nobody is skipped by the check', plan.eligibleIds.length === 5, { eligible: plan.eligibleIds.length, skipped: plan.skipped });

  const onlyA1 = await planBlast({ ...(await draftRow(f2.draft.id)), accountIds: [a1.id] });
  check('original mailbox not chosen is reported (so Start can refuse it)', (onlyA1.followUp?.missingMailboxes.includes(a2.id) ?? false), onlyA1.followUp);
  const fallbackPlan = await planBlast({ ...(await draftRow(f2.draft.id)), accountIds: [a1.id], onMailboxDown: 'FALLBACK' });
  check('with "another mailbox" the batch of the unchosen mailbox goes out from one that is chosen (new thread)', fallbackPlan.plannedAccountIds.every((id) => id === a1.id) && (fallbackPlan.followUp?.newThread ?? 0) >= 2, { ids: fallbackPlan.plannedAccountIds, f: fallbackPlan.followUp });

  const individual = await planBlast({ ...(await draftRow(f2.draft.id)), mode: 'INDIVIDUAL' });
  check('individual mode: one email per recruiter, each replying to their own earlier email', individual.groupSpecs.length === 5 && individual.groupSpecs.filter((s) => s.sourceGroupId).length === 4, individual.groupSpecs.map((s) => [s.ids.length, !!s.sourceGroupId]));

  // ───────── Start (what POST …/start writes) and send, with a fake Gmail ─────────
  async function start(blastId: string, over: Record<string, unknown> = {}) {
    const b = await prisma.recruiterBlast.update({ where: { id: blastId }, data: over });
    const p = await planBlast(b);
    for (let i = 0; i < p.groupSpecs.length; i++) {
      const s = p.groupSpecs[i]!;
      const g = await prisma.recruiterBlastGroup.create({ data: { blastId, seq: i + 1, recipientCount: s.ids.length, plannedAccountId: p.plannedAccountIds[i] ?? null, inReplyToGroupId: s.sourceGroupId } });
      await prisma.recruiterBlastRecipient.updateMany({ where: { id: { in: s.ids } }, data: { groupId: g.id, status: 'QUEUED' } });
    }
    await prisma.recruiterBlast.update({ where: { id: blastId }, data: { status: 'SENDING', startedAt: new Date() } });
    return p;
  }
  console.log('\nSending round 2 (fake Gmail)');
  await start(f2.draft.id);
  const gm = fakeGmail();
  const res = await run(gm.send);
  const bySubject = gm.sent.filter((m) => m.subject === 'Re: Hiring partners');
  check('3 emails went out, none failed', res.sent === 3 && res.failed === 0 && bySubject.length === 3, { res, n: gm.sent.length });
  const m1 = gm.sent.find((m) => m.threadId === 'T1');
  const m2 = gm.sent.find((m) => m.threadId === 'T2');
  const mNew = gm.sent.find((m) => !m.threadId);
  check('batch 1 replies in thread T1 from mailbox one, In-Reply-To the original message', !!m1 && m1.from === a1.emailAddress && m1.inReplyTo === '<m1@x>' && m1.references === '<m1@x>', m1);
  check('batch 2 replies in thread T2 from mailbox two', !!m2 && m2.from === a2.emailAddress && m2.inReplyTo === '<m2@x>', m2);
  check('the new address gets a fresh thread (no threadId / In-Reply-To)', !!mNew && !mNew.inReplyTo, mNew);
  check('BCC batches carry only their own recruiters', !!m1 && sorted(m1.bcc).join() === sorted([email('r2'), email('r4')]).join() && !!m2 && sorted(m2.bcc).join() === sorted([email('r5'), email('r7')]).join(), { m1: m1?.bcc, m2: m2?.bcc });
  const after2 = await draftRow(f2.draft.id);
  check('the follow-up completes', after2.status === 'COMPLETED', after2.status);
  check('recipients are marked sent', (await rowsOf(f2.draft.id)).every((x) => x.status === 'SENT'));
  const sentGroups = await prisma.recruiterBlastGroup.findMany({ where: { blastId: f2.draft.id }, select: { gmailThreadId: true, messageIdHeader: true, inReplyToGroupId: true, status: true } });
  check('the sent follow-up groups record their thread and Message-ID (so replies are recognised)', sentGroups.every((g) => g.status === 'SENT' && g.gmailThreadId && g.messageIdHeader), sentGroups);

  // ───────── Replies across the chain ─────────
  console.log('\nReplies across rounds');
  const when = new Date();
  await markRecruiterReplied(f2.draft.id, email('r2').toUpperCase(), when);
  const root1 = await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: root.id, email: email('r2') } });
  const fu1 = await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: f2.draft.id, email: email('r2') } });
  check('a reply to the follow-up marks the recruiter replied in the first send too (any email case)', !!root1?.repliedAt && !!fu1?.repliedAt);
  await markRecruiterReplied(root.id, email('r2'), new Date(Date.now() + 1000));
  check('a second reply does not overwrite the first reply time', (await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: root.id, email: email('r2') } }))!.repliedAt!.getTime() === root1!.repliedAt!.getTime());
  const stranger = await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: root.id, email: email('r4') } });
  check('replies from one recruiter never mark another', !stranger?.repliedAt);

  // ───────── Round 3 ─────────
  console.log('\nRound 3');
  const c3 = await chainCandidates(root.id);
  const r2c = c3.find((c) => c.email === email('r2'));
  check('r2 replied, so they are no longer in "no reply"', r2c?.replied === true);
  const latest = await prisma.recruiterBlastGroup.findFirst({ where: { blastId: f2.draft.id, gmailThreadId: 'T1' } });
  check('a recruiter\'s source for round 3 is their round-2 email, not the first', c3.find((c) => c.email === email('r4'))?.sourceGroupId === latest?.id, { src: c3.find((c) => c.email === email('r4'))?.sourceGroupId, latest: latest?.id });
  const f3 = await newFollowUp({ id: f2.draft.id, round: 2, rootBlastId: root.id, subject: 'Re: Hiring partners' }, NOT_REPLIED_SEGMENTS);
  check('round 3 targets only those who still have not replied (r4, r5, r7 + the new address)', f3.n === 4, f3.n);
  check('the subject keeps a single Re: in round 3', (await draftRow(f3.draft.id)).subject === 'Re: Hiring partners');
  await start(f3.draft.id);
  const gm3 = fakeGmail();
  await run(gm3.send);
  const t1 = gm3.sent.find((m) => m.threadId === 'T1');
  check('round 3 continues thread T1, replying to the round-2 message, with the whole References chain', !!t1 && t1.inReplyTo === latest?.messageIdHeader && t1.references === `<m1@x> ${latest?.messageIdHeader}`, t1);

  // ───────── Mailbox down: WAIT vs FALLBACK, late replies and unsubscribes ─────────
  console.log('\nMailbox unavailable, late replies, late unsubscribes');
  async function blockMailbox(accountId: string) {
    const dummy = await prisma.recruiterBlast.create({ data: { ...base, name: 'Backoff dummy', mode: 'BCC', accountIds: [accountId], status: 'CANCELLED' } });
    return prisma.recruiterBlastGroup.create({ data: { blastId: dummy.id, seq: 1, status: 'FAILED', recipientCount: 1, accountId, errorCode: 'RATE_LIMIT', error: 'slow down', sentAt: new Date() } });
  }
  const f4 = await newFollowUp({ id: f3.draft.id, round: 3, rootBlastId: root.id, subject: 'Re: Hiring partners' }, NOT_REPLIED_SEGMENTS);
  const block = await blockMailbox(a2.id);
  await start(f4.draft.id);
  const gm4 = fakeGmail();
  const w = await run(gm4.send);
  check('WAIT: batches of the healthy mailbox go out, the paused mailbox\'s batch waits', gm4.sent.every((m) => m.from === a1.emailAddress) && gm4.sent.length >= 1, gm4.sent.map((m) => m.from));
  const waiting = await draftRow(f4.draft.id);
  check('WAIT: the send stays open and says why (not completed, not failed)', waiting.status === 'SENDING' && /paused by Gmail/.test(waiting.note ?? w.waiting ?? ''), { status: waiting.status, note: waiting.note, w });
  check('WAIT: nothing is sent from the paused mailbox or as a new thread', !gm4.sent.some((m) => m.from === a2.emailAddress || !m.threadId));
  await prisma.recruiterBlastGroup.delete({ where: { id: block.id } });
  const gm4b = fakeGmail();
  await run(gm4b.send);
  check('WAIT: when the mailbox is back, its batch goes out in its own thread and the send completes', gm4b.sent.length >= 1 && gm4b.sent.every((m) => m.from === a2.emailAddress && !!m.threadId) && (await draftRow(f4.draft.id)).status === 'COMPLETED', { sent: gm4b.sent.map((m) => [m.from, m.threadId]), status: (await draftRow(f4.draft.id)).status });

  // FALLBACK on a fresh chain (round 5 from f4)
  const f5 = await newFollowUp({ id: f4.draft.id, round: 4, rootBlastId: root.id, subject: 'Re: Hiring partners' }, NOT_REPLIED_SEGMENTS, { onMailboxDown: 'FALLBACK' });
  const block2 = await blockMailbox(a2.id);
  await start(f5.draft.id);
  const gm5 = fakeGmail();
  await run(gm5.send);
  const fromA2Rerouted = gm5.sent.filter((m) => m.from === a1.emailAddress && !m.threadId);
  check('FALLBACK: the paused mailbox\'s batch is sent at once from another mailbox, as a new thread', fromA2Rerouted.length >= 1 && (await draftRow(f5.draft.id)).status === 'COMPLETED', { sent: gm5.sent.map((m) => [m.from, m.threadId]) });
  check('FALLBACK: the healthy mailbox\'s batches still reply in their thread', gm5.sent.some((m) => m.from === a1.emailAddress && !!m.threadId));
  await prisma.recruiterBlastGroup.delete({ where: { id: block2.id } });

  // Late reply / unsubscribe while queued
  const f6 = await newFollowUp({ id: f5.draft.id, round: 5, rootBlastId: root.id, subject: 'Re: Hiring partners' }, NOT_REPLIED_SEGMENTS);
  await start(f6.draft.id);
  const victim = (await rowsOf(f6.draft.id))[0]!.email;
  const unsub = (await rowsOf(f6.draft.id))[1]!.email;
  await markRecruiterReplied(root.id, victim, new Date());
  await prisma.emailSuppression.create({ data: { workspaceId: ws.id, email: unsub, reason: 'UNSUBSCRIBED', source: 'QA' } });
  const gm6 = fakeGmail();
  await run(gm6.send);
  const all6 = gm6.sent.flatMap((m) => [m.to, ...m.bcc]);
  check('someone who replied after the follow-up was prepared is not emailed', !all6.includes(victim), { victim, all6 });
  check('someone who unsubscribed after it was prepared is not emailed', !all6.includes(unsub), { unsub, all6 });
  const skipped = await prisma.recruiterBlastRecipient.findMany({ where: { blastId: f6.draft.id, status: 'SKIPPED' }, select: { email: true, skipReason: true } });
  check('both are shown as skipped with a reason', skipped.length === 2 && skipped.every((s) => !!s.skipReason), skipped);

  // ───────── Individual chain: opens known ─────────
  console.log('\nChain 2: individual copies (opens known)');
  const root2 = await prisma.recruiterBlast.create({ data: { ...base, name: 'Root individual', mode: 'INDIVIDUAL', accountIds: [a1.id], status: 'COMPLETED', gapSeconds: 0 } });
  const mk2 = async (n: string, opts: { opens?: number; replied?: boolean }) => {
    const g = await prisma.recruiterBlastGroup.create({ data: { blastId: root2.id, seq: Math.floor(Math.random() * 1e9), status: 'SENT', recipientCount: 1, accountId: a1.id, fromEmail: a1.emailAddress, gmailThreadId: `I-${n}`, messageIdHeader: `<i-${n}@x>`, sentAt: new Date() } });
    await prisma.recruiterBlastRecipient.create({ data: { blastId: root2.id, email: email(`i${n}`), name: n, data: { Name: n, Email: email(`i${n}`), Company: 'Co' }, groupId: g.id, status: 'SENT', sentAt: new Date(), openCount: opts.opens ?? 0, openedAt: opts.opens ? new Date() : null, repliedAt: opts.replied ? new Date() : null } });
  };
  await mk2('a', { opens: 3 });
  await mk2('b', {});
  await mk2('c', { opens: 1, replied: true });
  await mk2('d', {});
  const c2 = segmentCounts(await chainCandidates(root2.id));
  check('individual chain: opened 1, not opened 2, replied 1 (a reply wins over an open)', c2.NO_REPLY_OPENED === 1 && c2.NO_REPLY_UNOPENED === 2 && c2.REPLIED === 1 && c2.NO_REPLY_UNKNOWN === 0, c2);
  const fi = await newFollowUp({ id: root2.id, round: 1, rootBlastId: null, subject: 'Hiring partners' }, ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED'], { mode: 'INDIVIDUAL', toAddress: null });
  check('opened + not opened ticked together = all 3 who have not replied', fi.n === 3, fi.n);
  check('only opened → 1; only not opened → 2', (await applyAudience(fi.draft.id, fi.rootId, ['NO_REPLY_OPENED'])) === 1 && (await applyAudience(fi.draft.id, fi.rootId, ['NO_REPLY_UNOPENED'])) === 2);

  // ───────── Big list ─────────
  console.log('\nBig list (6,000 recruiters)');
  const big = await prisma.recruiterBlast.create({ data: { ...base, name: 'Big root', mode: 'BCC', toAddress: `p@${DOMAIN}`, accountIds: [a1.id], status: 'COMPLETED' } });
  const bigGroups = await prisma.recruiterBlastGroup.createManyAndReturn({ data: Array.from({ length: 24 }, (_, i) => ({ blastId: big.id, seq: i + 1, status: 'SENT', recipientCount: 250, accountId: a1.id, fromEmail: a1.emailAddress, gmailThreadId: `B${i}`, messageIdHeader: `<b${i}@x>`, sentAt: new Date() })), select: { id: true } });
  const bigRows = Array.from({ length: 6000 }, (_, i) => ({ blastId: big.id, email: `big${i}+${stamp}@gmail.com`, name: `B ${i}`, data: { Name: `B ${i}`, Email: `big${i}@x.com`, Company: 'C' }, groupId: bigGroups[Math.floor(i / 250)]!.id, status: 'SENT', sentAt: new Date(), repliedAt: i % 10 === 0 ? new Date() : null }));
  for (let i = 0; i < bigRows.length; i += 1000) await prisma.recruiterBlastRecipient.createMany({ data: bigRows.slice(i, i + 1000) });
  let t = Date.now();
  const bc = await chainCandidates(big.id);
  const tCand = Date.now() - t;
  const bf = await newFollowUp({ id: big.id, round: 1, rootBlastId: null, subject: 'Big' }, NOT_REPLIED_SEGMENTS, { accountIds: [a1.id] });
  t = Date.now();
  const bp = await planBlast(await draftRow(bf.draft.id));
  const tPlan = Date.now() - t;
  check(`6,000 recruiters: candidates in ${tCand} ms, 5,400 not replied, plan in ${tPlan} ms with 24 batches`, bc.length === 6000 && bf.n === 5400 && bp.groupSpecs.length === 24 && tCand < 5000 && tPlan < 60000, { n: bc.length, sel: bf.n, batches: bp.groupSpecs.length, tCand, tPlan });
}

main()
  .catch((err) => {
    fail++;
    failures.push(`script crashed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
  })
  .finally(async () => {
    if (orgId) await cleanup(orgId).catch((e) => console.error('cleanup failed (remove org', orgId, 'by hand):', e.message));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
