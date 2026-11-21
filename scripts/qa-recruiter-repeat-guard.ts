/**
 * QA of the Recruiter Bulk Send repeat guard (a recruiter emailed in the last N days is skipped unless the
 * admin chooses to send again) against a running app (laptop standby DB), with throwaway fixtures in their
 * own organizations. Nothing is sent: the mailbox has no tokens and the one start is SCHEDULED a year ahead.
 *
 * Usage: BASE_URL=http://localhost:3021 npx tsx scripts/qa-recruiter-repeat-guard.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { BatchStatus, CampaignStatus, EmailJobStatus, Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3021';
const COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass++; console.log(`  PASS ${name}`); } else { fail++; failures.push(name); console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); }
}
async function sessionFor(userId: string) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken, userId, expires: new Date(Date.now() + 3600_000) } });
  return `${COOKIE}=${sessionToken}`;
}
async function call(method: string, path: string, cookie: string | null, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html or csv */ }
  return { status: res.status, json, text };
}

const stamp = Date.now();
const DOMAIN = `rrg-${stamp}.test`;
const orgIds: string[] = [];
const DAY = 86_400_000;
const em = (n: string) => `${n}+${stamp}@gmail.com`;

async function cleanup(id: string) {
  const blasts = (await prisma.recruiterBlast.findMany({ where: { organizationId: id }, select: { id: true } })).map((b) => b.id);
  await prisma.recruiterBlastRecipient.deleteMany({ where: { blastId: { in: blasts } } });
  await prisma.recruiterBlastGroup.deleteMany({ where: { blastId: { in: blasts } } });
  await prisma.recruiterBlast.deleteMany({ where: { id: { in: blasts } } });
  const campaigns = (await prisma.campaign.findMany({ where: { organizationId: id }, select: { id: true } })).map((c) => c.id);
  await prisma.conversationMessage.deleteMany({ where: { conversation: { organizationId: id } } });
  await prisma.conversation.deleteMany({ where: { organizationId: id } });
  await prisma.contact.deleteMany({ where: { organizationId: id } });
  await prisma.emailJob.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.batch.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.campaign.deleteMany({ where: { id: { in: campaigns } } });
  const datasets = (await prisma.dataset.findMany({ where: { organizationId: id }, select: { id: true } })).map((d) => d.id);
  await prisma.record.deleteMany({ where: { datasetId: { in: datasets } } });
  const templates = (await prisma.template.findMany({ where: { organizationId: id }, select: { id: true } })).map((t) => t.id);
  await prisma.templateVersion.deleteMany({ where: { templateId: { in: templates } } });
  await prisma.template.deleteMany({ where: { id: { in: templates } } });
  await prisma.dataset.deleteMany({ where: { id: { in: datasets } } });
  const users = (await prisma.user.findMany({ where: { organizationId: id }, select: { id: true } })).map((u) => u.id);
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: id } });
  await prisma.integrationSettings.deleteMany({ where: { organizationId: id } });
  await prisma.emailProviderAccount.deleteMany({ where: { organizationId: id } });
  await prisma.workspace.deleteMany({ where: { organizationId: id } });
  await prisma.user.deleteMany({ where: { organizationId: id } });
  await prisma.organization.delete({ where: { id } });
}

async function main() {
  console.log(`=== Recruiter repeat guard QA against ${BASE_URL} ===\n`);
  const org = await prisma.organization.create({ data: { name: `RRG ${stamp}`, allowedDomain: DOMAIN } });
  const org2 = await prisma.organization.create({ data: { name: `RRG other ${stamp}`, allowedDomain: `other-${DOMAIN}` } });
  orgIds.push(org.id, org2.id);
  const mkUser = (o: string, tag: string, role: Role) => prisma.user.create({ data: { organizationId: o, googleId: `rrg-${tag}-${stamp}`, email: `rrg-${tag}+${stamp}@${DOMAIN}`, name: `RRG ${tag}`, role } });
  const admin = await mkUser(org.id, 'admin', Role.ADMIN);
  const op = await mkUser(org.id, 'op', Role.OPERATOR);
  const admin2 = await mkUser(org2.id, 'admin2', Role.ADMIN);
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: `RRG ws ${stamp}` } });
  await prisma.workspace.create({ data: { organizationId: org.id, ownerId: op.id, name: `RRG op ${stamp}` } });
  const ws2 = await prisma.workspace.create({ data: { organizationId: org2.id, ownerId: admin2.id, name: `RRG ws2 ${stamp}` } });
  const acct = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: admin.id, emailAddress: `box-${stamp}@${DOMAIN}`, displayName: 'box', status: 'CONNECTED' } });

  const base = { organizationId: org.id, workspaceId: ws.id, createdById: admin.id, html: '<p>Hello {{Name}}</p>', plainText: 'Hello', body: 'Hello {{Name}}', columns: ['Name', 'Email'], emailColumn: 'Email', gapSeconds: 3, accountIds: [acct.id] };
  const rec = (blastId: string, n: string, status: string, sentAt: Date | null, extra: Record<string, unknown> = {}) =>
    prisma.recruiterBlastRecipient.create({ data: { blastId, email: em(n), name: n.toUpperCase(), data: { Name: n.toUpperCase(), Email: em(n) }, status, sentAt, ...extra } });

  // ── History in this organization ──
  const past = await prisma.recruiterBlast.create({ data: { ...base, name: 'Dec drive', subject: 'Hiring drive – Dec', mode: 'INDIVIDUAL', status: 'COMPLETED', startedAt: new Date(), completedAt: new Date() } });
  const grp = await prisma.recruiterBlastGroup.create({ data: { blastId: past.id, seq: 1, status: 'SENT', recipientCount: 1, accountId: acct.id, fromEmail: acct.emailAddress, sentAt: new Date() } });
  await rec(past.id, 'a1', 'SENT', new Date(Date.now() - 3 * DAY - 3600_000), { groupId: grp.id }); // 3 days + 1 h ago: inside 10 days
  await rec(past.id, 'a2', 'SENT', new Date(Date.now() - 12 * DAY)); // 12 days ago: outside
  await rec(past.id, 'a3', 'SENT', new Date(Date.now() - 3600_000)); // 1 hour ago
  await rec(past.id, 'a4', 'FAILED', null); // never delivered: does not count
  await rec(past.id, 'a5', 'SKIPPED', null); // skipped: does not count
  const queued = await prisma.recruiterBlast.create({ data: { ...base, name: 'Queued drive', subject: 'Coming up', mode: 'INDIVIDUAL', status: 'SCHEDULED', scheduledAt: new Date(Date.now() + 5 * DAY) } });
  await rec(queued.id, 'q1', 'QUEUED', null);
  const cancelled = await prisma.recruiterBlast.create({ data: { ...base, name: 'Cancelled drive', subject: 'Never went', mode: 'INDIVIDUAL', status: 'CANCELLED' } });
  await rec(cancelled.id, 'c1', 'QUEUED', null); // a cancelled send's queue does not count
  // Another organization's send to the same address must not count.
  const foreign = await prisma.recruiterBlast.create({ data: { ...base, organizationId: org2.id, workspaceId: ws2.id, createdById: admin2.id, accountIds: [], name: 'Foreign', subject: 'Elsewhere', mode: 'INDIVIDUAL', status: 'COMPLETED' } });
  await rec(foreign.id, 'x1', 'SENT', new Date(Date.now() - DAY));
  // A campaign / Quick Send email, address stored in mixed case.
  const dataset = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: 'RRG data' } });
  const template = await prisma.template.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: 'RRG template', versions: { create: { version: 1, subject: 'Campaign subject', html: '<p>x</p>', plainText: 'x', variables: [], createdById: admin.id } } }, include: { versions: true } });
  const version = template.versions[0]!;
  const campaign = await prisma.campaign.create({ data: { organizationId: org.id, workspaceId: ws.id, name: 'Spring campaign', datasetId: dataset.id, templateId: template.id, templateVersionId: version.id, createdById: admin.id, senderAccountId: acct.id, status: CampaignStatus.COMPLETED } });
  const batch = await prisma.batch.create({ data: { campaignId: campaign.id, label: `rrg-${stamp}`, status: BatchStatus.COMPLETED, total: 3, validCount: 3, skippedCount: 0 } });
  const job = async (n: string, status: EmailJobStatus, ageMs: number, email = em(n)) => {
    const record = await prisma.record.create({ data: { datasetId: dataset.id, data: { Email: email } } });
    await prisma.emailJob.create({ data: { batchId: batch.id, campaignId: campaign.id, recordId: record.id, templateVersionId: version.id, emailProviderAccountId: acct.id, status, toEmail: email, fromName: 'RRG', fromEmail: acct.emailAddress, subject: 'Campaign subject', html: '<p>x</p>', sentAt: status === 'SENT' ? new Date(Date.now() - ageMs) : null } });
  };
  await job('j1', EmailJobStatus.SENT, 2.5 * DAY, `J1+${stamp}@Gmail.com`); // mixed case
  await job('j2', EmailJobStatus.FAILED, DAY); // failed: does not count
  await job('j3', EmailJobStatus.SENT, 15 * DAY); // outside the window

  // ── The draft being prepared ──
  const draft = await prisma.recruiterBlast.create({ data: { ...base, name: 'QA draft', subject: 'Hiring partners', mode: 'INDIVIDUAL', status: 'DRAFT' } });
  const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'q1', 'c1', 'x1', 'j1', 'j2', 'j3', 'n1', 'n2'];
  for (const n of names) await rec(draft.id, n, 'PENDING', null);
  // The mixed-case campaign address is in the list in lower case, as the paste always lowercases.
  await prisma.recruiterBlastRecipient.update({ where: { blastId_email: { blastId: draft.id, email: em('j1') } }, data: { email: `j1+${stamp}@gmail.com` } });
  const RECENT = 4; // a1 (3d), a3 (1h), q1 (queued elsewhere), j1 (campaign, 2.5d)
  const adminCookie = await sessionFor(admin.id);
  const opCookie = await sessionFor(op.id);
  const otherCookie = await sessionFor(admin2.id);

  console.log('Access');
  check('signed out: GET is 401', (await call('GET', `/api/recruiter-blasts/${draft.id}/recent`, null)).status === 401);
  check('signed out: POST is 401', (await call('POST', `/api/recruiter-blasts/${draft.id}/recent`, null, { action: 'include', scope: { emails: [em('a1')] } })).status === 401);
  check('operator (not admin): 403', (await call('GET', `/api/recruiter-blasts/${draft.id}/recent`, opCookie)).status === 403);
  check('an admin of another organization: 403', [403, 404].includes((await call('GET', `/api/recruiter-blasts/${draft.id}/recent`, otherCookie)).status));

  console.log('\nWhat counts as "emailed recently"');
  const chk = await call('POST', `/api/recruiter-blasts/${draft.id}/check`, adminCookie, {});
  check('the check skips exactly the recently emailed (sent inside 10 days, queued elsewhere, campaign, mixed case)', chk.status === 200 && chk.json?.skippedByReason?.RECENTLY_EMAILED === RECENT, chk.json?.skippedByReason ?? chk.json);
  check('…and everyone else stays eligible', chk.json?.eligible === names.length - RECENT, { eligible: chk.json?.eligible, total: chk.json?.total });
  check('the plan reports the window and the counts', chk.json?.recent?.windowDays === 10 && chk.json?.recent?.flagged === RECENT && chk.json?.recent?.included === 0, chk.json?.recent);
  check('the skip reason names the last email (subject, when, send)', (chk.json?.skipped ?? []).some((s: any) => s.email === em('a1') && /Hiring drive – Dec/.test(s.reason) && /3 days ago/.test(s.reason) && /Dec drive/.test(s.reason)), (chk.json?.skipped ?? []).find((s: any) => s.email === em('a1')));
  const list = await call('GET', `/api/recruiter-blasts/${draft.id}/recent`, adminCookie);
  const byEmail = new Map<string, any>((list.json?.rows ?? []).map((r: any) => [r.email, r]));
  check('the review list has the same four people', list.status === 200 && list.json?.totals?.recent === RECENT && list.json?.matching === RECENT, list.json?.totals);
  check('a1: last subject, source and mailbox', byEmail.get(em('a1'))?.subject === 'Hiring drive – Dec' && /Dec drive/.test(byEmail.get(em('a1'))?.source) && byEmail.get(em('a1'))?.from === acct.emailAddress, byEmail.get(em('a1')));
  check('q1: shown as queued in another send, not sent yet', byEmail.get(em('q1'))?.pending === true && byEmail.get(em('q1'))?.sentAt === null && /Queued drive/.test(byEmail.get(em('q1'))?.source), byEmail.get(em('q1')));
  check('j1: the campaign email is found although stored in mixed case', /Spring campaign/.test(byEmail.get(`j1+${stamp}@gmail.com`)?.source ?? ''), byEmail.get(`j1+${stamp}@gmail.com`));
  check('not counted: older than 10 days, failed, skipped, cancelled queue, another organization', ![em('a2'), em('a4'), em('a5'), em('c1'), em('x1'), em('j2'), em('j3'), em('n1')].some((e) => byEmail.has(e)));
  check('the list is newest first (a3, 1 hour ago, comes before a1)', list.json?.rows?.findIndex((r: any) => r.email === em('a3')) < list.json?.rows?.findIndex((r: any) => r.email === em('a1')), list.json?.rows?.map((r: any) => r.email));
  const search = await call('GET', `/api/recruiter-blasts/${draft.id}/recent?q=${encodeURIComponent('spring')}`, adminCookie);
  check('search finds by source name… (subject or email)', (await call('GET', `/api/recruiter-blasts/${draft.id}/recent?q=${encodeURIComponent('Hiring drive')}`, adminCookie)).json?.matching === 2 && search.json?.matching === 0, search.json?.matching);

  console.log('\nChoosing who gets it again');
  const inc = await call('POST', `/api/recruiter-blasts/${draft.id}/recent`, adminCookie, { action: 'include', scope: { emails: [em('a1'), em('a1').toUpperCase(), 'nobody@example.com', em('n1')] } });
  check('tick one (plus an unknown address and one never emailed) → only the real one changes', inc.status === 200 && inc.json?.changed === 1, inc.json);
  const chk2 = await call('POST', `/api/recruiter-blasts/${draft.id}/check`, adminCookie, {});
  check('the check now sends to a1 and still skips the other three', chk2.json?.eligible === names.length - RECENT + 1 && chk2.json?.recent?.flagged === RECENT - 1 && chk2.json?.recent?.included === 1, chk2.json?.recent);
  const bulk = await call('POST', `/api/recruiter-blasts/${draft.id}/recent`, adminCookie, { action: 'include', scope: { all: true, olderThanDays: 2 } });
  // a1 (3 d) is already included; j1 (2.5 d) qualifies; a3 (1 h) and q1 (queued) do not.
  check('"everyone emailed 2+ days ago" → only j1 newly included (a3 and the queued one stay out)', bulk.status === 200 && bulk.json?.changed === 2, bulk.json); // a1 + j1 matched by the filter (a1 is set again)
  const afterBulk = await call('GET', `/api/recruiter-blasts/${draft.id}/recent?show=included`, adminCookie);
  check('included list = a1 and j1', afterBulk.json?.matching === 2 && afterBulk.json?.rows?.every((r: any) => r.sendAgain), afterBulk.json?.rows?.map((r: any) => r.email));
  const allSkip = await call('POST', `/api/recruiter-blasts/${draft.id}/recent`, adminCookie, { action: 'skip', scope: { all: true, show: 'included' } });
  check('"skip all included" clears them', allSkip.json?.changed === 2 && (await call('GET', `/api/recruiter-blasts/${draft.id}/recent?show=included`, adminCookie)).json?.matching === 0, allSkip.json);
  const allInc = await call('POST', `/api/recruiter-blasts/${draft.id}/recent`, adminCookie, { action: 'include', scope: { all: true } });
  check('select all matching (every page) → all 4 will get it again', allInc.json?.changed === RECENT && (await call('POST', `/api/recruiter-blasts/${draft.id}/check`, adminCookie, {})).json?.eligible === names.length, allInc.json);
  await call('POST', `/api/recruiter-blasts/${draft.id}/recent`, adminCookie, { action: 'skip', scope: { all: true } });
  check('bad action → 400', (await call('POST', `/api/recruiter-blasts/${draft.id}/recent`, adminCookie, { action: 'delete-everything', scope: { all: true } })).status === 400);
  check('empty tick list → 400', (await call('POST', `/api/recruiter-blasts/${draft.id}/recent`, adminCookie, { action: 'include', scope: { emails: [] } })).status === 400);
  const csv = await call('GET', `/api/recruiter-blasts/${draft.id}/recent?format=csv`, adminCookie);
  check('download: a CSV with the last subject per recruiter', csv.status === 200 && /Hiring drive – Dec/.test(csv.text) && csv.text.split('\r\n').filter(Boolean).length === RECENT + 1, csv.text.slice(0, 300));
  const rm = await call('POST', `/api/recruiter-blasts/${draft.id}/recent`, adminCookie, { action: 'remove', scope: { emails: [em('q1'), em('n1')] } });
  check('remove from list: only the recently emailed one goes (n1 was never emailed, so it is not touched)', rm.json?.changed === 1 && (await prisma.recruiterBlastRecipient.count({ where: { blastId: draft.id } })) === names.length - 1 && !!(await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: draft.id, email: em('n1') } })), rm.json);

  console.log('\nThe window setting and follow-ups');
  const zero = await call('PATCH', `/api/recruiter-blasts/${draft.id}`, adminCookie, { repeatWindowDays: 0 });
  check('window 0 = off: saved, and the check skips nobody as recent', zero.status === 200 && (await call('POST', `/api/recruiter-blasts/${draft.id}/check`, adminCookie, {})).json?.skippedByReason?.RECENTLY_EMAILED === undefined, zero.json?.error);
  check('…and the review list says so', (await call('GET', `/api/recruiter-blasts/${draft.id}/recent`, adminCookie)).json?.windowDays === 0);
  check('91 days is refused (400)', (await call('PATCH', `/api/recruiter-blasts/${draft.id}`, adminCookie, { repeatWindowDays: 91 })).status === 400);
  const three = await call('PATCH', `/api/recruiter-blasts/${draft.id}`, adminCookie, { repeatWindowDays: 3 });
  const chk3 = await call('POST', `/api/recruiter-blasts/${draft.id}/check`, adminCookie, {});
  check('a 3-day window catches only a3 (1 h) and j1 (2.5 days); a1 (3 days 1 h) is now outside', three.status === 200 && chk3.json?.skippedByReason?.RECENTLY_EMAILED === 2, chk3.json?.skippedByReason); // q1 was removed from the list above
  await call('PATCH', `/api/recruiter-blasts/${draft.id}`, adminCookie, { repeatWindowDays: 10 });
  const fu = await prisma.recruiterBlast.create({ data: { ...base, name: 'QA follow-up', subject: 'Re: Hiring drive', mode: 'INDIVIDUAL', status: 'DRAFT', parentBlastId: past.id, rootBlastId: past.id, round: 2, followUpAudience: 'EVERYONE' } });
  await rec(fu.id, 'a1', 'PENDING', null);
  await rec(fu.id, 'a3', 'PENDING', null);
  const fuChk = await call('POST', `/api/recruiter-blasts/${fu.id}/check`, adminCookie, {});
  check('a follow-up is exempt: re-emailing the same recruiters is its point', fuChk.status === 200 && fuChk.json?.skippedByReason?.RECENTLY_EMAILED === undefined && fuChk.json?.recent?.windowDays === 0, { s: fuChk.json?.skippedByReason, r: fuChk.json?.recent });
  check('…and its review list is empty and says why', (await call('GET', `/api/recruiter-blasts/${fu.id}/recent`, adminCookie)).json?.exempt === true);

  console.log('\nStarting');
  const only = await prisma.recruiterBlast.create({ data: { ...base, name: 'QA only recent', subject: 'Hi', mode: 'INDIVIDUAL', status: 'DRAFT' } });
  await rec(only.id, 'a1', 'PENDING', null);
  await rec(only.id, 'a3', 'PENDING', null);
  const none = await call('POST', `/api/recruiter-blasts/${only.id}/start`, adminCookie, { scheduledAt: new Date(Date.now() + 365 * DAY).toISOString() });
  check('everyone recently emailed → refused with a message that says what to do', none.status === 400 && /emailed in the last 10 days/.test(none.json?.error ?? '') && /Review and choose/.test(none.json?.error ?? ''), none.json);
  await call('POST', `/api/recruiter-blasts/${only.id}/recent`, adminCookie, { action: 'include', scope: { emails: [em('a1')] } });
  const when = new Date(Date.now() + 365 * DAY).toISOString();
  const started = await call('POST', `/api/recruiter-blasts/${only.id}/start`, adminCookie, { scheduledAt: when });
  check('one chosen to send again → starts (scheduled a year ahead), 1 email', started.status === 200 && started.json?.messages === 1 && started.json?.skipped === 1, started.json);
  const rows = await prisma.recruiterBlastRecipient.findMany({ where: { blastId: only.id }, select: { email: true, status: true, skipReason: true, repeatOk: true } });
  const sk = rows.find((r) => r.email === em('a3'));
  check('the skipped one keeps its reason on the send, the chosen one is queued', sk?.status === 'SKIPPED' && /Emailed today/.test(sk.skipReason ?? '') && /Hiring drive – Dec/.test(sk.skipReason ?? '') && rows.find((r) => r.email === em('a1'))?.status === 'QUEUED', rows);
  check('after the start the choice is locked (409)', (await call('POST', `/api/recruiter-blasts/${only.id}/recent`, adminCookie, { action: 'skip', scope: { emails: [em('a1')] } })).status === 409);
  const audit = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'RECRUITER_SEND_START', targetId: only.id } });
  check('the start is audited with the repeat-guard counts', (audit?.metadata as any)?.repeatGuard?.skippedAsRecent === 1 && (audit?.metadata as any)?.repeatGuard?.sendAgain === 1, audit?.metadata);
  const dup = await prisma.recruiterBlast.create({ data: { ...base, name: 'QA second', subject: 'Again', mode: 'INDIVIDUAL', status: 'DRAFT' } });
  await rec(dup.id, 'a1', 'PENDING', null);
  const dupChk = await call('POST', `/api/recruiter-blasts/${dup.id}/check`, adminCookie, {});
  check('two sends started minutes apart: the second sees the first one queued and flags the same recruiter', dupChk.json?.skippedByReason?.RECENTLY_EMAILED === 1, dupChk.json?.skippedByReason);
  const copy = await call('POST', `/api/recruiter-blasts/${only.id}/copy`, adminCookie, {});
  const copyChk = await call('POST', `/api/recruiter-blasts/${copy.json?.id}/check`, adminCookie, {});
  check('a copy of a send starts clean: the earlier "send again" choice is not carried over', copyChk.json?.recent?.included === 0, copyChk.json?.recent);
  const pg = await call('GET', `/recruiter-send/${draft.id}`, adminCookie);
  check('the send page loads', pg.status === 200, pg.status);

  console.log('\nA big list');
  const big = await prisma.recruiterBlast.create({ data: { ...base, name: 'QA big', subject: 'Big', mode: 'BCC', toAddress: `to@${DOMAIN}`, html: '<p>Hello</p>', body: 'Hello', columns: [], emailColumn: null, status: 'DRAFT' } });
  const emails = Array.from({ length: 20_000 }, (_, i) => `bulk${i}+${stamp}@gmail.com`);
  for (let i = 0; i < emails.length; i += 2000) await prisma.recruiterBlastRecipient.createMany({ data: emails.slice(i, i + 2000).map((email) => ({ blastId: big.id, email })) });
  // 30 of them were emailed 2 days ago.
  const prev = await prisma.recruiterBlast.create({ data: { ...base, name: 'Big earlier', subject: 'Earlier', mode: 'INDIVIDUAL', status: 'COMPLETED' } });
  await prisma.recruiterBlastRecipient.createMany({ data: emails.slice(0, 30).map((email) => ({ blastId: prev.id, email, status: 'SENT', sentAt: new Date(Date.now() - 2 * DAY) })) });
  const t0 = Date.now();
  const bigList = await call('GET', `/api/recruiter-blasts/${big.id}/recent`, adminCookie);
  const t1 = Date.now() - t0;
  check(`20,000 recruiters: the 30 recent ones are found in ${t1} ms (under 8 s)`, bigList.status === 200 && bigList.json?.totals?.recent === 30 && t1 < 8000, { t1, totals: bigList.json?.totals, err: bigList.json?.error });
  const t2s = Date.now();
  const bigChk = await call('POST', `/api/recruiter-blasts/${big.id}/check`, adminCookie, {});
  const t2 = Date.now() - t2s;
  check(`…and the whole check runs in ${t2} ms (under 30 s) with 19,970 eligible`, bigChk.status === 200 && bigChk.json?.eligible === 19_970 && t2 < 30_000, { t2, e: bigChk.json?.eligible, err: bigChk.json?.error });
  const bigAll = await call('POST', `/api/recruiter-blasts/${big.id}/recent`, adminCookie, { action: 'include', scope: { all: true } });
  check('"select all matching" on a big list changes exactly the 30', bigAll.json?.changed === 30, bigAll.json);


  console.log('\nRound 2: aliases, inbox replies, cool-off, send-time re-check, organisation default');
  const mk = async (name: string, status = 'DRAFT', extra: Record<string, unknown> = {}) => prisma.recruiterBlast.create({ data: { ...base, html: '<p>Hello</p>', plainText: 'Hello', body: 'Hello', columns: [], emailColumn: null, name, subject: name, mode: 'INDIVIDUAL', status, ...extra } });
  const g = (n: string, tag = '') => `${n}${tag}${stamp}@gmail.com`;

  // The same inbox written two ways.
  const SQLKEY_SAMPLES = ['a.b@gmail.com', 'AB+tag@Gmail.com', 'x.y.z+1+2@googlemail.com', 'Raj.K@Company.com', 'plain@outlook.com', 'a.b@gmail.com.evil.test'];
  const sqlKeys = await prisma.$queryRaw<{ k: string }[]>`SELECT mailflow_email_key(e) AS k FROM unnest(${SQLKEY_SAMPLES}::text[]) WITH ORDINALITY AS t(e, n) ORDER BY n`;
  const { emailKey } = await import('../lib/recruiterSend/emailKey');
  check('the database key function and the code agree on every sample', sqlKeys.map((r) => r.k).join('|') === SQLKEY_SAMPLES.map((e) => emailKey(e)).join('|'), { db: sqlKeys.map((r) => r.k), js: SQLKEY_SAMPLES.map((e) => emailKey(e)) });
  const aliasPast = await mk('Alias past', 'COMPLETED');
  await prisma.recruiterBlastRecipient.create({ data: { blastId: aliasPast.id, email: `al.ic.e${stamp}@gmail.com`, status: 'SENT', sentAt: new Date(Date.now() - 3 * DAY) } });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: aliasPast.id, email: `d.ave${stamp}@outlook.com`, status: 'SENT', sentAt: new Date(Date.now() - 3 * DAY) } });
  const aliasDraft = await mk('Alias draft');
  for (const e of [`alice${stamp}+news@gmail.com`, `dave${stamp}@outlook.com`, g('fresh')]) await prisma.recruiterBlastRecipient.create({ data: { blastId: aliasDraft.id, email: e } });
  const aChk = await call('POST', `/api/recruiter-blasts/${aliasDraft.id}/check`, adminCookie, {});
  check('alice+news@gmail.com is the same person as al.ic.e@gmail.com (flagged), but dave@outlook.com is not d.ave@outlook.com', aChk.json?.skippedByReason?.RECENTLY_EMAILED === 1 && (aChk.json?.skipped ?? []).some((s: any) => s.email.startsWith(`alice${stamp}`)) && aChk.json?.eligible === 2, { s: aChk.json?.skippedByReason, e: aChk.json?.eligible });
  const paste = await call('POST', `/api/recruiter-blasts/${aliasDraft.id}/recipients`, adminCookie, { source: 'paste', text: `x.y${stamp}@gmail.com\nxy${stamp}+t@gmail.com\nXY${stamp}@googlemail.com\nz${stamp}@company-x.test` });
  check('pasting the same Gmail inbox three ways adds it once (2 recruiters, not 4)', paste.status === 200 && paste.json?.added === 2, paste.json);

  // A manual reply written in the Inbox counts as "emailed"; a campaign email's inbox copy does not count twice.
  const contact = await prisma.contact.create({ data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: g('reply'), name: 'Replied' } });
  const convo = await prisma.conversation.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, contactId: contact.id, recipientEmail: g('reply'), subject: 'Partnership question', emailProviderAccountId: acct.id } });
  await prisma.conversationMessage.create({ data: { conversationId: convo.id, direction: 'OUTBOUND', senderEmail: acct.emailAddress, recipientEmail: g('reply'), subject: 'Re: Partnership question', sentAt: new Date(Date.now() - 2 * DAY), status: 'SENT' } });
  const copyConvo = await prisma.conversation.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, contactId: (await prisma.contact.create({ data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: g('cj'), name: 'CJ' } })).id, recipientEmail: g('cj'), subject: 'Campaign subject', emailProviderAccountId: acct.id } });
  const cjAt = new Date(Date.now() - 4 * DAY);
  await prisma.conversationMessage.create({ data: { conversationId: copyConvo.id, direction: 'OUTBOUND', senderEmail: acct.emailAddress, recipientEmail: g('cj'), subject: 'Campaign subject', sentAt: cjAt, status: 'SENT' } });
  await job('cj', EmailJobStatus.SENT, 4 * DAY, g('cj'));
  const replyDraft = await mk('Reply draft');
  for (const e of [g('reply'), g('cj'), g('quiet')]) await prisma.recruiterBlastRecipient.create({ data: { blastId: replyDraft.id, email: e } });
  const rList = await call('GET', `/api/recruiter-blasts/${replyDraft.id}/recent`, adminCookie);
  const rr = new Map<string, any>((rList.json?.rows ?? []).map((r: any) => [r.email, r]));
  check('an Inbox reply counts as emailed: "Inbox reply", with its subject', rr.get(g('reply'))?.source === 'Inbox reply' && rr.get(g('reply'))?.subject === 'Re: Partnership question', rr.get(g('reply')));
  check('a campaign email and its Inbox copy count once, as the campaign', rr.get(g('cj'))?.source?.startsWith('Campaign') && rr.get(g('cj'))?.count === 1, rr.get(g('cj')));
  const rChk = await call('POST', `/api/recruiter-blasts/${replyDraft.id}/check`, adminCookie, {});
  check('the check skips both and says "You replied" for the Inbox reply', rChk.json?.skippedByReason?.RECENTLY_EMAILED === 2 && (rChk.json?.skipped ?? []).some((s: any) => /You replied/.test(s.reason)), rChk.json?.skipped);

  // Cool-off on the contact record.
  const until = new Date(Date.now() + 5 * DAY);
  await prisma.contact.create({ data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: g('co.ol'), name: 'Cool', doNotContactUntil: until, coolOffNote: 'On leave until December' } });
  await prisma.contact.create({ data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: g('over'), name: 'Over', doNotContactUntil: new Date(Date.now() - DAY) } }); // already over
  const coolDraft = await mk('Cool draft');
  for (const e of [g('cool'), g('over'), g('free')]) await prisma.recruiterBlastRecipient.create({ data: { blastId: coolDraft.id, email: e } });
  const cChk = await call('POST', `/api/recruiter-blasts/${coolDraft.id}/check`, adminCookie, {});
  check('a cool-off skips the person (alias-matched), an expired one does not', cChk.json?.skippedByReason?.COOL_OFF === 1 && cChk.json?.eligible === 2 && cChk.json?.recent?.coolOff === 1, { s: cChk.json?.skippedByReason, e: cChk.json?.eligible });
  check('…and the reason names the date and the note', (cChk.json?.skipped ?? []).some((s: any) => /Do not contact until/.test(s.reason) && /On leave until December/.test(s.reason)), cChk.json?.skipped);
  // Even if the same person was emailed lately AND the admin chose "send again", the cool-off stands.
  await prisma.recruiterBlastRecipient.create({ data: { blastId: aliasPast.id, email: g('cool'), status: 'SENT', sentAt: new Date(Date.now() - DAY) } });
  await call('POST', `/api/recruiter-blasts/${coolDraft.id}/recent`, adminCookie, { action: 'include', scope: { all: true } });
  const cChk2 = await call('POST', `/api/recruiter-blasts/${coolDraft.id}/check`, adminCookie, {});
  check('"send again" never overrides a cool-off', cChk2.json?.skippedByReason?.COOL_OFF === 1 && (cChk2.json?.skipped ?? []).find((s: any) => s.email === g('cool'))?.reason.startsWith('Do not contact'), cChk2.json?.skipped);
  check('a person on a cool-off is not offered in the "recently emailed" review', !((await call('GET', `/api/recruiter-blasts/${coolDraft.id}/recent`, adminCookie)).json?.rows ?? []).some((r: any) => r.email === g('cool')));
  const coolFollow = await prisma.recruiterBlast.create({ data: { ...base, html: '<p>Hello</p>', plainText: 'Hello', body: 'Hello', columns: [], emailColumn: null, name: 'Cool follow-up', subject: 'Re: x', mode: 'INDIVIDUAL', status: 'DRAFT', parentBlastId: past.id, rootBlastId: past.id, round: 2, followUpAudience: 'EVERYONE' } });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: coolFollow.id, email: g('cool') } });
  check('a follow-up skips a cool-off too (only the repeat check is exempt)', (await call('POST', `/api/recruiter-blasts/${coolFollow.id}/check`, adminCookie, {})).json?.skippedByReason?.COOL_OFF === 1);
  const startCool = await call('POST', `/api/recruiter-blasts/${coolDraft.id}/start`, adminCookie, { scheduledAt: new Date(Date.now() + 365 * DAY).toISOString() });
  const coolRow = await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: coolDraft.id, email: g('cool') }, select: { status: true, skipKind: true } });
  check('at start the skip code is saved on the recruiter (COOL_OFF)', startCool.status === 200 && coolRow?.status === 'SKIPPED' && coolRow?.skipKind === 'COOL_OFF', { startCool: startCool.json, coolRow });

  // The check made just before each message goes out (send time).
  const { dropRecentlyEmailed } = await import('../lib/recruiterSend/worker');
  const sched = await mk('Scheduled for later', 'SCHEDULED', { scheduledAt: new Date(Date.now() + 2 * DAY), startedAt: null });
  const rowsFor = async (blastId: string) => (await prisma.recruiterBlastRecipient.findMany({ where: { blastId }, select: { id: true, email: true, repeatOk: true } }));
  for (const [e, ok] of [[g('first'), false], [g('queued'), false], [g('inflight'), false], [g('again'), true], [g('quiet2'), false], [g('replied2'), false]] as [string, boolean][]) await prisma.recruiterBlastRecipient.create({ data: { blastId: sched.id, email: e, status: 'QUEUED', repeatOk: ok } });
  const other = await mk('Went out first', 'SENDING', { startedAt: new Date() });
  const og = await prisma.recruiterBlastGroup.create({ data: { blastId: other.id, seq: 1, status: 'SENDING', recipientCount: 1, accountId: acct.id, fromEmail: acct.emailAddress } });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: other.id, email: g('fi.rst'), status: 'SENT', sentAt: new Date() } }); // sent: alias of "first"
  await prisma.recruiterBlastRecipient.create({ data: { blastId: other.id, email: g('queued'), status: 'QUEUED' } }); // only queued there: first to send wins, so this one still sends here
  await prisma.recruiterBlastRecipient.create({ data: { blastId: other.id, email: g('inflight'), status: 'QUEUED', groupId: og.id } }); // going out this second
  await prisma.recruiterBlastRecipient.create({ data: { blastId: other.id, email: g('again'), status: 'SENT', sentAt: new Date() } }); // sent, but chosen "send again"
  const convo3 = await prisma.conversation.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, contactId: (await prisma.contact.create({ data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: g('replied2'), name: 'R2' } })).id, recipientEmail: g('replied2'), subject: 'x', emailProviderAccountId: acct.id } });
  await prisma.conversationMessage.create({ data: { conversationId: convo3.id, direction: 'OUTBOUND', senderEmail: acct.emailAddress, recipientEmail: g('replied2'), subject: 'Quick answer', sentAt: new Date(Date.now() - 3600_000), status: 'SENT' } });
  const schedRows = await rowsFor(sched.id);
  const kept = await dropRecentlyEmailed(await prisma.recruiterBlast.findUniqueOrThrow({ where: { id: sched.id } }), schedRows);
  const keptEmails = new Set(kept.map((r) => r.email));
  check('send time: someone who was sent to meanwhile (even as an alias) is skipped', !keptEmails.has(g('first')));
  check('send time: someone in flight in another send this second is skipped', !keptEmails.has(g('inflight')));
  check('send time: someone answered in the Inbox meanwhile is skipped', !keptEmails.has(g('replied2')));
  check('send time: queued-only elsewhere still sends (the first to send wins, so two sends never skip each other)', keptEmails.has(g('queued')));
  check('send time: "send again" and never-emailed recruiters still send', keptEmails.has(g('again')) && keptEmails.has(g('quiet2')));
  const dropped = await prisma.recruiterBlastRecipient.findMany({ where: { blastId: sched.id, status: 'SKIPPED' }, select: { email: true, skipKind: true, skipReason: true } });
  check('send time: the skipped ones are marked SKIPPED with the code and a reason', dropped.length === 3 && dropped.every((d) => d.skipKind === 'RECENTLY_EMAILED' && /just before sending/.test(d.skipReason ?? '')), dropped);
  const coolSched = await mk('Cool scheduled', 'SCHEDULED', { scheduledAt: new Date(Date.now() + DAY) });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: coolSched.id, email: g('cool'), status: 'QUEUED', repeatOk: true } });
  const keptCool = await dropRecentlyEmailed(await prisma.recruiterBlast.findUniqueOrThrow({ where: { id: coolSched.id } }), await rowsFor(coolSched.id));
  check('send time: a cool-off that started after Start is honoured too, even with "send again"', keptCool.length === 0);
  const fuSend = await prisma.recruiterBlast.create({ data: { ...base, name: 'Follow-up sending', subject: 'Re: y', mode: 'INDIVIDUAL', status: 'SENDING', parentBlastId: past.id, rootBlastId: past.id, round: 2, startedAt: new Date() } });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: fuSend.id, email: g('fi.rst'), status: 'QUEUED' } });
  const keptFu = await dropRecentlyEmailed(await prisma.recruiterBlast.findUniqueOrThrow({ where: { id: fuSend.id } }), await rowsFor(fuSend.id));
  check('send time: a follow-up is not stopped by the repeat check', keptFu.length === 1);

  // The organisation default for new sends.
  await prisma.integrationSettings.upsert({ where: { organizationId: org.id }, create: { organizationId: org.id, settings: { recruiter: { repeatWindowDays: 5 } } }, update: { settings: { recruiter: { repeatWindowDays: 5 } } } });
  const created = await call('POST', '/api/recruiter-blasts', adminCookie, {});
  const detail = await call('GET', `/api/recruiter-blasts/${created.json?.id}`, adminCookie);
  check('a new send takes the organisation default (5 days)', created.status === 200 && detail.json?.blast?.repeatWindowDays === 5, { created: created.json, rw: detail.json?.blast?.repeatWindowDays });
  await prisma.integrationSettings.update({ where: { organizationId: org.id }, data: { settings: {} } });
  const created2 = await call('POST', '/api/recruiter-blasts', adminCookie, {});
  check('without a saved default a new send gets 10 days', (await call('GET', `/api/recruiter-blasts/${created2.json?.id}`, adminCookie)).json?.blast?.repeatWindowDays === 10);

  if (process.env.SHOT_FILE) {
    // A realistic draft for the browser check: 130 recently emailed (3 pages), awkward long values, a few never emailed.
    const shot = await prisma.recruiterBlast.create({ data: { ...base, name: 'QA screenshot draft', subject: 'Hiring partners', mode: 'INDIVIDUAL', status: 'DRAFT' } });
    const longSubject = 'Masai School x ' + 'Very Long Company Name Private Limited '.repeat(5) + '— hiring partnership for the January 2027 cohort';
    const earlier = await prisma.recruiterBlast.create({ data: { ...base, name: 'Earlier shot send with a rather long name for the table', subject: longSubject, mode: 'INDIVIDUAL', status: 'COMPLETED' } });
    const rows = Array.from({ length: 140 }, (_, i) => (i < 130 ? `shot${i}+${stamp}@gmail.com` : `fresh${i}+${stamp}@gmail.com`));
    rows[0] = `a.very.long.recruiter.address.that.goes.on.and.on.${stamp}@gmail.com`;
    rows[1] = 'not-an-email-at-all'; // invalid: skipped for that reason, so it must not be listed as "recently emailed"
    await prisma.recruiterBlastRecipient.createMany({ data: rows.map((email, i) => ({ blastId: shot.id, email, name: i % 3 ? `Recruiter ${i}` : null, data: { Name: `Recruiter ${i}`, Email: email } })) });
    await prisma.recruiterBlastRecipient.createMany({ data: rows.slice(0, 130).map((email, i) => ({ blastId: earlier.id, email, status: 'SENT', sentAt: new Date(Date.now() - (i % 9) * DAY - 3600_000 * (i % 20)) })) });
    const fs = await import('node:fs');
    fs.writeFileSync(process.env.SHOT_FILE, JSON.stringify({ id: shot.id, cookie: adminCookie }));
    await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 240_000)));
  }
}

main()
  .catch((err) => { fail++; failures.push(`script crashed: ${err instanceof Error ? err.message : String(err)}`); console.error(err); })
  .finally(async () => {
    for (const id of orgIds) await cleanup(id).catch((e) => console.error('cleanup failed (remove org', id, 'by hand):', e.message));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
