/**
 * Batches / History / All Conversations — HTTP smoke test for the pages
 * that replaced the last placeholders. Fixture data is created directly
 * (a campaign with a batch and jobs, a conversation with an inbound reply),
 * exercised through the APIs and the rendered pages, then deleted.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/smoke-test-pages-http.ts
 */
import 'dotenv/config';
import { prisma } from '../lib/db/client';
import { Role, EmailProvider as EmailProviderEnum } from '@prisma/client';
import crypto from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SESSION_COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

async function createSessionFor(userId: string) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken, userId, expires: new Date(Date.now() + 3600_000) } });
  return `${SESSION_COOKIE}=${sessionToken}`;
}

async function call(path: string, cookie: string | null) {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML */
  }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`=== MailFlow pages HTTP smoke test against ${BASE_URL} ===\n`);
  const stamp = Date.now();
  const org = await prisma.organization.upsert({ where: { allowedDomain: 'masaischool.com' }, update: {}, create: { name: 'Masai School', allowedDomain: 'masaischool.com' } });
  const op = await prisma.user.create({ data: { organizationId: org.id, googleId: `pg-op-${stamp}`, email: `pg-op+${stamp}@masaischool.com`, name: 'Pages Operator', role: Role.OPERATOR } });
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: op.id, name: 'Pages WS' } });
  const other = await prisma.user.create({ data: { organizationId: org.id, googleId: `pg-other-${stamp}`, email: `pg-other+${stamp}@masaischool.com`, name: 'Pages Other', role: Role.OPERATOR } });
  await prisma.workspace.create({ data: { organizationId: org.id, ownerId: other.id, name: 'Pages Other WS' } });
  const admin = await prisma.user.create({ data: { organizationId: org.id, googleId: `pg-admin-${stamp}`, email: `pg-admin+${stamp}@masaischool.com`, name: 'Pages Admin', role: Role.SUPER_ADMIN } });
  await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: 'Pages Admin WS' } });

  const dataset = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: op.id, name: `Pages dataset ${stamp}` } });
  const rec = await prisma.record.create({ data: { datasetId: dataset.id, data: { Email: `stu+${stamp}@example.com` } } });
  // One record per job: (campaignId, recordId, templateVersionId) is the send-idempotency key.
  const recs = await Promise.all([1, 2, 3].map((i) => prisma.record.create({ data: { datasetId: dataset.id, data: { Email: `stu${i}+${stamp}@example.com` } } })));
  const template = await prisma.template.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: op.id, name: `Pages template ${stamp}` } });
  const version = await prisma.templateVersion.create({ data: { templateId: template.id, version: 1, subject: 'Pages subject', html: '<p>Hi</p>', variables: [], createdById: op.id } });
  const campaign = await prisma.campaign.create({
    data: { organizationId: org.id, workspaceId: ws.id, name: `Pages campaign ${stamp}`, datasetId: dataset.id, templateId: template.id, templateVersionId: version.id, createdById: op.id, status: 'COMPLETED' },
  });
  const batch = await prisma.batch.create({ data: { campaignId: campaign.id, label: `BATCH-PAGES-${stamp}`, status: 'PARTIALLY_FAILED', total: 3, validCount: 3, sentCount: 1, failedCount: 1, skippedCount: 1 } });
  const job = (status: 'SENT' | 'FAILED' | 'SKIPPED', to: string, extra: Record<string, unknown> = {}, recordId = rec.id) =>
    prisma.emailJob.create({
      data: { batchId: batch.id, campaignId: campaign.id, recordId, templateVersionId: version.id, status, toEmail: to, fromName: 'Pages', fromEmail: 'pages@example.com', subject: 'Pages subject', html: '<p>Hi</p>', ...extra },
    });
  await job('SENT', `sent+${stamp}@example.com`, { sentAt: new Date() }, recs[0]!.id);
  await job('FAILED', `failed+${stamp}@example.com`, { errorCode: 'INVALID_RECIPIENT', errorMessage: 'Address rejected by Gmail' }, recs[1]!.id);
  await job('SKIPPED', `skipped+${stamp}@example.com`, { skipReason: 'Duplicate email in dataset' }, recs[2]!.id);

  const account = await prisma.emailProviderAccount.create({
    data: { organizationId: org.id, workspaceId: ws.id, userId: op.id, provider: EmailProviderEnum.GMAIL, emailAddress: `pages-${stamp}@example.com`, status: 'DISCONNECTED' },
  });
  const contact = await prisma.contact.create({ data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: `stu+${stamp}@example.com`, name: 'Pages Student' } });
  const conversation = await prisma.conversation.create({
    data: { organizationId: org.id, workspaceId: ws.id, ownerId: op.id, contactId: contact.id, recipientEmail: contact.primaryEmail, subject: `Pages thread ${stamp}`, emailProviderAccountId: account.id, gmailThreadId: `pg-${stamp}`, messageCount: 1, unread: true, lastMessageAt: new Date() },
  });
  await prisma.conversationMessage.create({
    data: { conversationId: conversation.id, direction: 'INBOUND', classification: 'HUMAN_REPLY', senderEmail: contact.primaryEmail, senderName: 'Pages Student', recipientEmail: account.emailAddress, subject: `Re: Pages thread ${stamp}`, snippet: 'Done with RPG', plainTextBody: 'Done with RPG', receivedAt: new Date() },
  });

  const opCookie = await createSessionFor(op.id);
  const otherCookie = await createSessionFor(other.id);
  const adminCookie = await createSessionFor(admin.id);

  try {
    console.log('-- batches --');
    let r = await call('/api/batches', null);
    check('anonymous 401', r.status === 401, r.status);
    r = await call('/api/batches', opCookie);
    check('lists the workspace batch with counters and pendingCount', r.status === 200 && r.json.batches.some((b: any) => b.id === batch.id && b.sentCount === 1 && b.failedCount === 1 && b.pendingCount === 0 && b.campaign.name === campaign.name), r.json);
    r = await call('/api/batches?status=active', opCookie);
    check('active filter excludes the finished batch', r.status === 200 && !r.json.batches.some((b: any) => b.id === batch.id), r.json?.batches?.length);
    r = await call(`/api/batches?q=PAGES-${stamp}`, opCookie);
    check('search by label', r.json?.batches?.length === 1, r.json?.batches?.length);
    r = await call('/api/batches', otherCookie);
    check("another workspace does not see it", r.status === 200 && !r.json.batches.some((b: any) => b.id === batch.id), r.json?.batches?.length);
    const page = await call('/batches', opCookie);
    check('batches page renders without the placeholder', page.status === 200 && !page.text.includes('Not yet implemented') && page.text.includes('Queue progress'), page.status);

    console.log('-- history --');
    r = await call('/api/history?direction=sent', opCookie);
    check('sent history lists all three jobs with outcomes', r.status === 200 && r.json.items.filter((j: any) => j.campaign.id === campaign.id).length === 3 && r.json.counts.SENT >= 1 && r.json.counts.FAILED >= 1, r.json?.counts);
    r = await call('/api/history?direction=sent&status=FAILED', opCookie);
    check('status filter', r.json?.items.every((j: any) => j.status === 'FAILED') && r.json.items.some((j: any) => j.errorMessage === 'Address rejected by Gmail'), r.json?.items?.length);
    r = await call(`/api/history?direction=sent&q=skipped%2B${stamp}`, opCookie);
    check('search by address', r.json?.items?.length === 1 && r.json.items[0].skipReason === 'Duplicate email in dataset', r.json?.items);
    r = await call('/api/history?direction=received', opCookie);
    check('received history lists the inbound reply with classification', r.status === 200 && r.json.items.some((m: any) => m.conversation.id === conversation.id && m.classification === 'HUMAN_REPLY'), r.json?.items?.length);
    r = await call('/api/history?direction=sent', otherCookie);
    check("another workspace sees none of it", !r.json.items.some((j: any) => j.campaign.id === campaign.id), r.json?.items?.length);
    const hist = await call('/history', opCookie);
    check('history page renders without the placeholder', hist.status === 200 && !hist.text.includes('Not yet implemented') && hist.text.includes('immutable'), hist.status);

    console.log('-- all conversations (super admin) --');
    r = await call('/api/admin/conversations', opCookie);
    check('operator forbidden (403)', r.status === 403, r.status);
    r = await call(`/api/admin/conversations?q=Pages%20thread%20${stamp}`, adminCookie);
    check('super admin finds the conversation across workspaces', r.status === 200 && r.json.conversations.length === 1 && r.json.conversations[0].workspace.name === 'Pages WS' && r.json.conversations[0].last?.snippet === 'Done with RPG', r.json);
    r = await call(`/api/admin/conversations?workspaceId=${ws.id}&status=unread`, adminCookie);
    check('workspace + unread filters', r.json?.conversations?.some((c: any) => c.id === conversation.id), r.json?.conversations?.length);
    check('workspace list provided for the filter', r.json?.workspaces?.some((w: any) => w.id === ws.id), r.json?.workspaces?.length);
    const audited = await prisma.auditLog.count({ where: { actorId: admin.id, action: 'ADMIN_VIEW', targetType: 'ConversationList' } });
    check('cross-workspace reads are audited', audited >= 2, audited);
    const adminPage = await call('/admin/conversations', adminCookie);
    check('all-conversations page renders without the placeholder', adminPage.status === 200 && !adminPage.text.includes('Not yet implemented'), adminPage.status);

    console.log('-- no placeholders anywhere --');
    for (const path of ['/dashboard', '/inbox', '/data', '/contacts', '/campaigns', '/templates', '/automations', '/settings']) {
      const p = await call(path, opCookie);
      check(`${path} has no "not yet implemented" / "coming in Phase" copy`, p.status === 200 && !/not yet implemented|coming in phase|planned in phase/i.test(p.text), p.status);
    }
  } finally {
    console.log('\n-- cleanup --');
    const ids = [op.id, other.id, admin.id];
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.conversationMessage.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.emailJob.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.batch.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.campaign.deleteMany({ where: { id: campaign.id } });
    await prisma.templateVersion.deleteMany({ where: { templateId: template.id } });
    await prisma.template.deleteMany({ where: { id: template.id } });
    await prisma.dataset.deleteMany({ where: { id: dataset.id } });
    await prisma.emailProviderAccount.deleteMany({ where: { id: account.id } });
    await prisma.recipientHistory.deleteMany({ where: { contactId: contact.id } });
    await prisma.contact.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.workspace.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
