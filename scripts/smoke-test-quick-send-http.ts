/**
 * Quick Send over HTTP against a deployment, with throwaway fixture users.
 * Nothing is emailed: fixture mailboxes have no Google login, and every send
 * is scheduled a year ahead, so the live sender leaves it alone.
 *
 * Usage: BASE_URL=https://<deployed-url> npx tsx scripts/smoke-test-quick-send-http.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { CampaignStatus, Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SESSION_COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
const PREFIX = 'qs-http+';
const YEAR_AHEAD = new Date(Date.now() + 365 * 86_400_000).toISOString();

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '');
  }
}

async function call(method: string, path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    redirect: 'manual',
    headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

async function removeFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const wss = (await prisma.workspace.findMany({ where: { ownerId: { in: ids } }, select: { id: true } })).map((w) => w.id);
  const campaigns = (await prisma.campaign.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((c) => c.id);
  await prisma.attachment.deleteMany({ where: { emailJob: { campaignId: { in: campaigns } } } });
  await prisma.emailJob.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.batch.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.campaignDocument.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.campaign.deleteMany({ where: { id: { in: campaigns } } });
  const docs = await prisma.documentTemplate.findMany({ where: { workspaceId: { in: wss } }, select: { id: true, fileId: true } });
  await prisma.documentTemplate.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
  await prisma.documentFile.deleteMany({ where: { id: { in: docs.map((d) => d.fileId) }, documentTemplates: { none: {} } } });
  const templates = (await prisma.template.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((t) => t.id);
  await prisma.templateVersion.deleteMany({ where: { templateId: { in: templates } } });
  await prisma.template.deleteMany({ where: { id: { in: templates } } });
  await prisma.dataset.deleteMany({ where: { workspaceId: { in: wss } } });
  await prisma.contact.deleteMany({ where: { workspaceId: { in: wss } } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.emailProviderAccount.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { targetId: { in: campaigns } }] } });
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.workspace.deleteMany({ where: { id: { in: wss } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  return users.length;
}

async function main() {
  console.log(`=== Quick Send HTTP smoke test against ${BASE_URL} ===\n`);
  const leftover = await removeFixtures();
  if (leftover) console.log(`Removed ${leftover} leftover fixture user(s).\n`);
  const stamp = Date.now();
  const org = await prisma.organization.upsert({ where: { allowedDomain: 'masaischool.com' }, update: {}, create: { name: 'Masai School', allowedDomain: 'masaischool.com' } });
  const mk = async (tag: string, role: Role, mailbox: boolean) => {
    const user = await prisma.user.create({ data: { organizationId: org.id, googleId: `qs-http-${tag}-${stamp}`, email: `${PREFIX}${tag}-${stamp}@masaischool.com`, name: `QS ${tag}`, role } });
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: user.id, name: `QS ${tag} ${stamp}` } });
    if (mailbox) {
      // CONNECTED but with no Google tokens: any attempt to email from it fails before reaching Google.
      await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: user.id, emailAddress: user.email, displayName: `QS ${tag}`, status: 'CONNECTED' } });
    }
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3600_000) } });
    return { user, ws, cookie: `${SESSION_COOKIE}=${token}` };
  };

  try {
    const op = await mk('op', Role.OPERATOR, true);
    const boss = await mk('boss', Role.SUPER_ADMIN, false);
    const viewer = await mk('viewer', Role.VIEWER, true);

    const recipients = {
      kind: 'table',
      headers: ['First Name', 'Mail ID', 'Company'],
      rows: [
        { 'First Name': 'Asha', 'Mail ID': `asha-${stamp}@example.com`, Company: 'Acme' },
        { 'First Name': 'Bo', 'Mail ID': `bo-${stamp}@example.com`, Company: 'Beta' },
        { 'First Name': 'Cy', 'Mail ID': `cy-${stamp}@example.com`, Company: 'Gamma' },
        { 'First Name': 'Dud', 'Mail ID': 'not-an-email', Company: 'Delta' },
      ],
    };
    const message = { subject: 'Hi {{First Name}}', body: 'Hello {{first name}} from {{Company}}.\n\nRegards', format: 'text' };

    console.log('Quick Send page');
    const page = await call('GET', '/quick-send', op.cookie);
    check('the page loads for an operator', page.status === 200 && page.text.includes('Quick Send'), page.status);
    const nav = page.text.slice(page.text.indexOf('Mail navigation'));
    check('it is the first item in the Mail sidebar', nav.indexOf('href="/quick-send"') > -1 && nav.indexOf('href="/quick-send"') < nav.indexOf('href="/dashboard"'));

    console.log('\nPasting a plain list');
    const { normalizePastedList } = await import('../lib/quickSend/paste');
    const pastedList = await call('POST', '/api/datasets/import/preview', op.cookie, {
      mode: 'paste',
      text: normalizePastedList('Rahul Sharma, rahul@example.com\nNeha Singh <neha@example.com>\namit@example.com'),
    });
    check('a pasted list is read as Name + Email rows', pastedList.status === 200 && JSON.stringify(pastedList.json?.headers) === '["Name","Email"]' && pastedList.json?.rows?.length === 3 && pastedList.json?.suggestedEmailColumn === 'Email', pastedList.json);

    console.log('\nCheck (dry run + preview, nothing saved)');
    const before = await prisma.campaign.count({ where: { workspaceId: op.ws.id } });
    const chk = await call('POST', '/api/quick-send', op.cookie, { mode: 'check', recipients, ...message });
    check('counts: 3 of 4 will get it, 1 invalid address skipped', chk.status === 200 && chk.json?.wouldSend === 3 && chk.json?.skipped === 1 && chk.json?.byReason?.INVALID_EMAIL === 1, chk.json);
    check('the email column is found by its contents ("Mail ID")', chk.json?.emailColumn === 'Mail_ID', chk.json?.emailColumn);
    check('preview is personalised from {{First Name}} and {{first name}}', chk.json?.preview?.subject === 'Hi Asha' && /Hello Asha from Acme/.test(chk.json?.preview?.html ?? ''), chk.json?.preview);
    check('an operator is told it needs approval', chk.json?.approval === 'required');
    check('the check saved nothing', (await prisma.campaign.count({ where: { workspaceId: op.ws.id } })) === before);
    const bad = await call('POST', '/api/quick-send', op.cookie, { mode: 'check', recipients, subject: 'Hi {{Nickname}}', body: 'x' });
    check('an unknown field is reported', JSON.stringify(bad.json?.unknownVariables) === '["Nickname"]', bad.json?.unknownVariables);
    const pasted = await call('POST', '/api/quick-send', op.cookie, { mode: 'send', recipients, subject: 'Hi {{Nickname}}', body: 'x', scheduledAt: YEAR_AHEAD });
    check('…and blocks the send', pasted.status === 400 && /Nickname/.test(pasted.json?.error ?? ''), pasted.json);
    const asViewer = await call('POST', '/api/quick-send', viewer.cookie, { mode: 'check', recipients, ...message });
    check('a viewer cannot use it', asViewer.status === 403, asViewer.status);

    const designed = await call('POST', '/api/quick-send', op.cookie, {
      mode: 'check',
      recipients,
      subject: 'Hi',
      format: 'text',
      body: '<!DOCTYPE html><html><head><style>.copy{color:#444444;font-size:14px}</style></head><body><p class="copy">Dear {{First Name}}</p></body></html>',
    });
    const designedHtml: string = designed.json?.preview?.html ?? '';
    check(
      'a pasted HTML email renders as designed, even in Simple mode (CSS inlined)',
      designed.json?.treatedAsHtml === true && /Dear Asha/.test(designedHtml) && /color: ?#444444/.test(designedHtml) && !designedHtml.includes('&lt;html'),
      designedHtml.slice(0, 300),
    );

    console.log('\nSignature, attachment, test send');
    await prisma.user.update({ where: { id: op.user.id }, data: { emailSignature: '<p>Regards,<br>QS Signature Line</p>' } });
    const withSig = await call('POST', '/api/quick-send', op.cookie, { mode: 'check', recipients, ...message, includeSignature: true });
    check('the saved signature is added to the email', withSig.json?.hasSignature === true && (withSig.json?.preview?.html ?? '').includes('QS Signature Line'), withSig.json?.preview?.html?.slice(-200));
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 200]);
    const pdfBytes = await pdf.save();
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' }), 'Offer Brochure.pdf');
    fd.append('name', 'Offer Brochure');
    const up = await fetch(`${BASE_URL}/api/documents`, { method: 'POST', headers: { Cookie: op.cookie }, body: fd });
    const upJson: any = await up.json().catch(() => ({}));
    const docId = upJson?.document?.id as string | undefined;
    check('a PDF can be attached (stored in the PDF Library)', up.status === 201 && !!docId, upJson);
    const withAtt = await call('POST', '/api/quick-send', op.cookie, { mode: 'check', recipients, ...message, attachmentDocumentIds: [docId] });
    check('the check lists the attachment', withAtt.json?.attachments?.length === 1 && withAtt.json.attachments[0].size > 0, withAtt.json?.attachments);
    const foreignAtt = await call('POST', '/api/quick-send', op.cookie, { mode: 'check', recipients, ...message, attachmentDocumentIds: ['not-a-real-document-id'] });
    check('an unknown attachment is refused', foreignAtt.status === 400, foreignAtt.status);
    const test = await call('POST', '/api/quick-send', op.cookie, { mode: 'test', recipients, ...message, attachmentDocumentIds: [docId] });
    // The fixture mailbox has no Google login, so the test email cannot leave: the route reports it instead of pretending.
    check('a test send goes through the real mailbox (fails safely for a fixture)', test.status === 502 && /could not be sent/.test(test.json?.error ?? ''), test.json);

    console.log('\nOperator sends → approval → sends on approval');
    const sent = await call('POST', '/api/quick-send', op.cookie, { mode: 'send', recipients, ...message, name: 'October drive: interview confirmations', cc: 'placements@example.com', scheduledAt: YEAR_AHEAD, attachmentDocumentIds: docId ? [docId] : [] });
    check('goes to approval', sent.status === 201 && sent.json?.state === 'awaiting_approval', sent.json);
    const id = sent.json?.campaignId as string;
    const camp = await prisma.campaign.findUnique({ where: { id }, include: { dataset: { include: { columns: true } }, templateVersion: true } });
    check('a normal campaign was created (pending approval, marked Quick Send)', camp?.status === CampaignStatus.PENDING_APPROVAL && camp?.description === 'Quick Send', camp?.status);
    check('it carries the campaign name you typed', camp?.name === 'October drive: interview confirmations', camp?.name);
    check('its list holds the 4 rows with an Email column', (await prisma.record.count({ where: { datasetId: camp!.datasetId } })) === 4 && camp!.dataset.columns.some((c) => c.key === 'Mail_ID' && c.type === 'EMAIL'));
    check('the message was stored with column keys', camp?.templateVersion.subject === 'Hi {{First_Name}}' && camp.templateVersion.html.includes('{{First_Name}}') && camp.templateVersion.html.includes('{{Company}}'), camp?.templateVersion.subject);
    check('contacts linked for reply threading', (await prisma.record.count({ where: { datasetId: camp!.datasetId, contactId: { not: null } } })) === 3);

    const list = await call('GET', '/api/approvals?status=pending', boss.cookie);
    const row = list.json?.requests?.find((r: any) => r.id === id);
    check('Approvals shows it as "sends when approved" with 4 recipients', row?.sendsOnApproval === true && row?.recipients === 4 && row?.quickSend === true, row);
    const approve = await call('POST', `/api/campaigns/${id}/approval`, boss.cookie, { action: 'APPROVE' });
    check('approving starts the send', approve.status === 200 && approve.json?.send?.ok === true, approve.json?.send);
    const afterApprove = await prisma.campaign.findUnique({ where: { id }, select: { status: true } });
    const jobs = await prisma.emailJob.findMany({ where: { campaignId: id }, select: { toEmail: true, subject: true, ccEmails: true } });
    check('3 personalised emails queued, scheduled (nothing goes out)', afterApprove?.status === CampaignStatus.SCHEDULED && jobs.length === 3 && jobs.every((j) => j.subject.startsWith('Hi ') && j.ccEmails[0] === 'placements@example.com'), { status: afterApprove?.status, jobs: jobs.length });
    const atts = await prisma.attachment.findMany({ where: { emailJob: { campaignId: id } }, select: { filename: true, campaignDocument: { select: { stampReference: true } } } });
    check('every email carries the PDF, unstamped', atts.length === 3 && atts.every((a) => /\.pdf$/i.test(a.filename) && a.campaignDocument?.stampReference === false), atts);

    console.log('\nTracking');
    const stats = await call('GET', `/api/quick-send/${id}`, op.cookie);
    check('live stats for the send', stats.status === 200 && stats.json?.stats?.total === 3 && stats.json.stats.queued === 3 && stats.json.stats.sent === 0, stats.json?.stats);
    const recent = await call('GET', '/api/quick-send', op.cookie);
    check('listed under recent Quick Sends', recent.json?.sends?.some((s: any) => s.campaignId === id));
    const otherStats = await call('GET', `/api/quick-send/${id}`, viewer.cookie);
    check('other workspaces cannot see it', otherStats.status === 404, otherStats.status);
  } finally {
    await removeFixtures();
    console.log('\nFixtures removed.');
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await removeFixtures().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
