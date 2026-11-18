/**
 * QA of the Quick Send follow-up HTTP routes and pages against a running app (laptop standby DB),
 * with throwaway fixtures in their own organization. Nothing is sent: the mailbox has no tokens
 * and the one real send is SCHEDULED a year ahead.
 *
 * Usage: BASE_URL=http://localhost:3011 npx tsx scripts/qa-quick-send-follow-up-http.ts
 *        (add SHOT=1 to hold the fixtures open and print what a screenshot needs)
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { ColumnType, Role } from '@prisma/client';
import { prisma } from '../lib/db/client';
import { QUICK_SEND_DESCRIPTION } from '../lib/quickSend/stats';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3011';
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
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

const stamp = Date.now();
const DOMAIN = `qsfu-http-${stamp}.test`;
let orgId = '';

async function cleanup(id: string) {
  const wss = (await prisma.workspace.findMany({ where: { organizationId: id }, select: { id: true } })).map((w) => w.id);
  const campaigns = (await prisma.campaign.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((c) => c.id);
  await prisma.emailTrackingEvent.deleteMany({ where: { campaignId: { in: campaigns } } });
  const convs = (await prisma.conversation.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((c) => c.id);
  await prisma.conversationMessage.deleteMany({ where: { conversationId: { in: convs } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convs } } });
  await prisma.attachment.deleteMany({ where: { emailJob: { campaignId: { in: campaigns } } } }).catch(() => undefined);
  await prisma.emailJob.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.batch.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.campaignDocument.deleteMany({ where: { campaignId: { in: campaigns } } }).catch(() => undefined);
  await prisma.campaign.deleteMany({ where: { id: { in: campaigns } } });
  const templates = (await prisma.template.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((t) => t.id);
  await prisma.templateVersion.deleteMany({ where: { templateId: { in: templates } } });
  await prisma.template.deleteMany({ where: { id: { in: templates } } });
  await prisma.dataset.deleteMany({ where: { workspaceId: { in: wss } } });
  await prisma.contact.deleteMany({ where: { workspaceId: { in: wss } } });
  await prisma.emailSuppression.deleteMany({ where: { workspaceId: { in: wss } } });
  const users = (await prisma.user.findMany({ where: { organizationId: id }, select: { id: true } })).map((u) => u.id);
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: id } });
  await prisma.integrationSettings.deleteMany({ where: { organizationId: id } });
  await prisma.emailProviderAccount.deleteMany({ where: { organizationId: id } });
  await prisma.workspace.deleteMany({ where: { organizationId: id } });
  await prisma.user.deleteMany({ where: { organizationId: id } });
  await prisma.organization.delete({ where: { id } });
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  console.log(`=== Quick Send follow-up HTTP QA against ${BASE_URL} ===\n`);
  const org = await prisma.organization.create({ data: { name: `QSFU HTTP ${stamp}`, allowedDomain: DOMAIN } });
  orgId = org.id;
  const mk = (tag: string) => prisma.user.create({ data: { organizationId: org.id, googleId: `qsfuh-${tag}-${stamp}`, email: `qsfuh-${tag}+${stamp}@${DOMAIN}`, name: `QSFU ${tag}`, role: Role.ADMIN } });
  const admin = await mk('admin');
  const other = await mk('other');
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: `QSFU ws ${stamp}` } });
  await prisma.workspace.create({ data: { organizationId: org.id, ownerId: other.id, name: `QSFU other ${stamp}` } });
  // A connected mailbox with no tokens: the app treats it as connected, Gmail can't be reached, so nothing can go out.
  const A1 = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: admin.id, emailAddress: `one-${stamp}@${DOMAIN}`, displayName: 'one', status: 'CONNECTED' } });

  const dataset = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: 'Quick send · root', columns: { create: [{ key: 'Name', label: 'Name', type: ColumnType.TEXT, order: 1 }, { key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 2 }] } } });
  const template = await prisma.template.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: 'Quick send · root', description: QUICK_SEND_DESCRIPTION } });
  const version = await prisma.templateVersion.create({ data: { templateId: template.id, version: 1, subject: 'Interview slots', html: '<p>Hello {{Name}}, original email</p>', plainText: 'Hello', variables: ['Name'], createdById: admin.id } });
  const mkCampaign = (name: string, status: 'COMPLETED' | 'RUNNING' | 'DRAFT') => prisma.campaign.create({ data: { organizationId: org.id, workspaceId: ws.id, name, description: QUICK_SEND_DESCRIPTION, datasetId: dataset.id, templateId: template.id, templateVersionId: version.id, createdById: admin.id, status, senderAccountId: A1.id } });
  const root = await mkCampaign('QA root', 'COMPLETED');
  const running = await mkCampaign('QA running', 'RUNNING');
  const batch = await prisma.batch.create({ data: { campaignId: root.id, label: `BATCH-QAH-${stamp}`, status: 'COMPLETED', total: 7, validCount: 7, sentCount: 7 } });
  const em = (n: string) => `${n}+${stamp}@gmail.com`;
  const people: { n: string; opened?: boolean; replied?: boolean; bounced?: boolean; suppressed?: boolean }[] = [
    { n: 'h1', opened: true }, { n: 'h2', opened: true }, { n: 'h3' }, { n: 'h4' }, { n: 'h5', replied: true }, { n: 'h6', bounced: true }, { n: 'h7', suppressed: true },
  ];
  for (const [i, p] of people.entries()) {
    const rec = await prisma.record.create({ data: { datasetId: dataset.id, data: { Name: p.n.toUpperCase(), Email: em(p.n) } } });
    const job = await prisma.emailJob.create({ data: { batchId: batch.id, campaignId: root.id, recordId: rec.id, templateVersionId: version.id, emailProviderAccountId: A1.id, status: 'SENT', toEmail: em(p.n), fromName: 'one', fromEmail: A1.emailAddress, subject: 'Interview slots', html: '<p>Hi</p>', sentAt: new Date(Date.now() - 2 * 864e5 + i), gmailThreadId: `HQ-${p.n}`, messageIdHeader: `<hq-${p.n}@x>`, errorCode: p.bounced ? 'BOUNCED' : null } });
    if (p.opened) await prisma.emailTrackingEvent.create({ data: { campaignId: root.id, emailJobId: job.id, email: em(p.n), type: 'OPEN', automated: false } });
    if (p.suppressed) await prisma.emailSuppression.create({ data: { workspaceId: ws.id, email: em(p.n), reason: 'UNSUBSCRIBED', source: 'QA' } });
    if (p.replied) {
      const c = await prisma.contact.create({ data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: em(p.n), name: p.n } });
      const conv = await prisma.conversation.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, contactId: c.id, recipientEmail: em(p.n), subject: 'Re: Interview slots', emailProviderAccountId: A1.id, gmailThreadId: `HQ-${p.n}`, messageCount: 1, firstMessageAt: new Date(), lastMessageAt: new Date() } });
      await prisma.conversationMessage.create({ data: { conversationId: conv.id, gmailThreadId: `HQ-${p.n}`, direction: 'INBOUND', classification: 'HUMAN_REPLY', senderEmail: em(p.n), recipientEmail: A1.emailAddress, cc: [], bcc: [], sentAt: new Date(Date.now() - 864e5), status: 'RECEIVED' } });
    }
  }
  const adminCookie = await sessionFor(admin.id);
  const otherCookie = await sessionFor(other.id);

  console.log('Access and pages');
  check('signed out: list is 401', (await call('GET', '/api/quick-send-follow-up', null)).status === 401);
  check('signed out: detail is 401', (await call('GET', `/api/quick-send-follow-up/${root.id}`, null)).status === 401);
  check('the Quick Send Follow-up page loads', (await call('GET', '/quick-send-follow-up', adminCookie)).status === 200);
  check('the follow-up compose page loads', (await call('GET', `/quick-send-follow-up/new?from=${root.id}`, adminCookie)).status === 200);
  check('plain Quick Send still loads', (await call('GET', '/quick-send', adminCookie)).status === 200);

  console.log('\nList');
  const list = await call('GET', '/api/quick-send-follow-up', adminCookie);
  const src = list.json?.sources?.find((s: any) => s.id === root.id);
  check('the finished send is offered with sent 7, opened 2, replied 1', list.status === 200 && src?.sent === 7 && src?.opened === 2 && src?.replied === 1 && src?.round === 1, src);
  check('a send that is still running is not offered', !list.json?.sources?.some((s: any) => s.id === running.id));
  check('another workspace sees none of it', !(await call('GET', '/api/quick-send-follow-up', otherCookie)).json?.sources?.some((s: any) => s.id === root.id));

  console.log('\nDetail');
  const det = await call('GET', `/api/quick-send-follow-up/${root.id}`, adminCookie);
  check('detail: counts opened 2, not opened 2 (h3 h4), replied 1, undeliverable 2, total 7', eq(det.json?.counts, { NO_REPLY_OPENED: 2, NO_REPLY_UNOPENED: 2, NO_REPLY_UNKNOWN: 0, REPLIED: 1, bounced: 2, total: 7 }), det.json?.counts);
  check('detail: suggested subject is "Re: <subject>"', det.json?.suggestedSubject === 'Re: Interview slots' && det.json?.parent?.subject === 'Interview slots');
  check('detail: the earlier email is shown (sanitised) with who sent it', /original email/.test(det.json?.parent?.html ?? '') && det.json?.parent?.sentFrom?.includes(A1.emailAddress));
  check('detail: each person has a group; bounced and suppressed are "undeliverable"', det.json?.candidates?.length === 7 && det.json.candidates.filter((c: any) => c.undeliverable).length === 2 && det.json.candidates.find((c: any) => c.email === em('h5'))?.segment === 'REPLIED');
  check('detail: nobody has a follow-up open yet', det.json?.openFollowUp === null);
  check('detail: another workspace → 404', (await call('GET', `/api/quick-send-follow-up/${root.id}`, otherCookie)).status === 404);
  check('detail: a send that is running → 409', (await call('GET', `/api/quick-send-follow-up/${running.id}`, adminCookie)).status === 409);
  check('detail: unknown send → 404', (await call('GET', '/api/quick-send-follow-up/nope', adminCookie)).status === 404);

  console.log('\nCheck (dry run)');
  const base = { mode: 'check', subject: 'Re: Interview slots', body: 'Hi {{Name}}, a quick follow-up.', format: 'text', includeSignature: false, attachmentDocumentIds: [], replyTo: '' };
  const chk = await call('POST', '/api/quick-send', adminCookie, { ...base, recipients: { kind: 'followUp', parentCampaignId: root.id, emails: [em('h1'), em('h2'), em('h3'), em('h4'), em('h7')] }, followUp: { onMailboxDown: 'WAIT', segments: ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED'] } });
  check('check: 4 of 5 will get it; the suppressed one is skipped', chk.status === 200 && chk.json?.wouldSend === 4 && chk.json?.skipped === 1, chk.json?.error ?? { w: chk.json?.wouldSend, s: chk.json?.skipped });
  check('check: all 4 reply in their thread, none new, nobody blocked', chk.json?.followUp?.replying === 4 && chk.json?.followUp?.newThread === 0 && eq(chk.json?.followUp?.blocked, []) && chk.json?.followUp?.round === 2, chk.json?.followUp);
  check('check: the preview is personalised with the person’s own name', /H1|H2|H3|H4/.test(chk.json?.preview?.html ?? ''), String(chk.json?.preview?.html).slice(0, 200));
  const withNew = await call('POST', '/api/quick-send', adminCookie, { ...base, body: 'Hi, a quick follow-up.', recipients: { kind: 'followUp', parentCampaignId: root.id, emails: [em('h1'), `fresh+${stamp}@gmail.com`] } });
  check('check: a new address is added and starts a new thread (1 replying, 1 new)', withNew.json?.followUp?.replying === 1 && withNew.json?.followUp?.newThread === 1 && withNew.json?.wouldSend === 2, withNew.json?.followUp);
  const withNewVar = await call('POST', '/api/quick-send', adminCookie, { ...base, recipients: { kind: 'followUp', parentCampaignId: root.id, emails: [em('h1'), `fresh2+${stamp}@gmail.com`] } });
  check('check: a new address has no columns, so {{Name}} is empty for them and they are skipped with a clear reason', withNewVar.json?.wouldSend === 1 && withNewVar.json?.skipped === 1 && /Missing value/.test(JSON.stringify(withNewVar.json?.skippedExamples ?? [])), { w: withNewVar.json?.wouldSend, ex: withNewVar.json?.skippedExamples });
  check('check: no people → 400', (await call('POST', '/api/quick-send', adminCookie, { ...base, recipients: { kind: 'followUp', parentCampaignId: root.id, emails: [] } })).status === 400);
  check('check: unknown send → 400 with a clear message', /not found/i.test((await call('POST', '/api/quick-send', adminCookie, { ...base, recipients: { kind: 'followUp', parentCampaignId: 'nope', emails: [em('h1')] } })).json?.error ?? ''));
  check('check: a running send can not be followed up → 400', (await call('POST', '/api/quick-send', adminCookie, { ...base, recipients: { kind: 'followUp', parentCampaignId: running.id, emails: [em('h1')] } })).status === 400);
  check('check: another workspace can not follow it up', (await call('POST', '/api/quick-send', otherCookie, { ...base, recipients: { kind: 'followUp', parentCampaignId: root.id, emails: [em('h1')] } })).status === 400);
  check('check: a bad mailbox choice is refused', (await call('POST', '/api/quick-send', adminCookie, { ...base, recipients: { kind: 'followUp', parentCampaignId: root.id, emails: [em('h1')] }, followUp: { onMailboxDown: 'MAYBE' } })).status === 400);
  check('check: a normal Quick Send is unchanged (no follow-up info)', (await call('POST', '/api/quick-send', adminCookie, { ...base, recipients: { kind: 'table', headers: ['Name', 'Email'], rows: [{ Name: 'X', Email: `plain+${stamp}@gmail.com` }] } })).json?.followUp === null);

  console.log('\nSend (scheduled a year ahead: nothing goes out)');
  const when = new Date(Date.now() + 365 * 864e5).toISOString();
  const payload = { ...base, mode: 'send', scheduledAt: when, recipients: { kind: 'followUp', parentCampaignId: root.id, emails: [em('h1'), em('h3'), em('h4')] }, followUp: { onMailboxDown: 'FALLBACK', segments: ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED'] }, requestId: `qsfu-http-${stamp}-1` };
  const sent = await call('POST', '/api/quick-send', adminCookie, payload);
  check('send → scheduled', sent.status === 201 && sent.json?.state === 'scheduled', sent.json);
  const fu = sent.json?.campaignId ? await prisma.campaign.findUnique({ where: { id: sent.json.campaignId } }) : null;
  check('the campaign records its parent, root, round 2, audience and the mailbox choice', fu?.parentCampaignId === root.id && fu.rootCampaignId === root.id && fu.round === 2 && fu.followUpAudience === 'NO_REPLY_OPENED,NO_REPLY_UNOPENED' && fu.onMailboxDown === 'FALLBACK', fu);
  const jobs = fu ? await prisma.emailJob.findMany({ where: { campaignId: fu.id }, select: { toEmail: true, replyThreadId: true, inReplyToJobId: true, status: true, emailProviderAccountId: true } }) : [];
  check('3 queued jobs, each replying in its own thread from the original mailbox', jobs.length === 3 && jobs.every((j) => j.status === 'QUEUED' && j.replyThreadId?.startsWith('HQ-') && j.inReplyToJobId && j.emailProviderAccountId === A1.id), jobs);
  const again = await call('POST', '/api/quick-send', adminCookie, payload);
  check('sending the same compose again returns the same campaign (no duplicate)', again.json?.campaignId === sent.json?.campaignId && again.json?.duplicate === true, again.json);
  const second = await call('POST', '/api/quick-send', adminCookie, { ...payload, requestId: `qsfu-http-${stamp}-2` });
  check('a second follow-up to the same send while one is scheduled is refused, pointing at it', second.status === 409 && second.json?.existingCampaignId === sent.json?.campaignId, second.json);
  const after = await call('GET', `/api/quick-send-follow-up/${root.id}`, adminCookie);
  check('the detail now reports the open follow-up', after.json?.openFollowUp?.id === sent.json?.campaignId);
  const l2 = await call('GET', '/api/quick-send-follow-up', adminCookie);
  check('the list shows the follow-up under "your follow-ups" and counts it on the send', l2.json?.followUps?.some((f: any) => f.id === sent.json?.campaignId && f.round === 2 && f.parentName === 'QA root') && l2.json?.sources?.find((s: any) => s.id === root.id)?.followUps === 1, l2.json?.followUps);
  check('the ordinary Quick Send history still lists it', (await call('GET', '/api/quick-send', adminCookie)).json?.sends?.some((s: any) => s.campaignId === sent.json?.campaignId));

  if (process.env.SHOT) {
    await prisma.campaign.update({ where: { id: sent.json.campaignId }, data: { status: 'CANCELLED' } });
    console.log(`\nSCREENSHOT_FROM=${root.id}`);
    console.log(`SCREENSHOT_COOKIE=${adminCookie}`);
    await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 120_000)));
  }
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
