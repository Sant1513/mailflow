/**
 * Quick Send building blocks against the REAL database, with throwaway
 * fixtures and nothing sent: bulk contact linking, and the bulk job snapshot
 * in startCampaignSend (scheduled a year ahead, so the live sender ignores it).
 *
 * Usage: npx tsx scripts/smoke-test-quick-send.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { BatchStatus, CampaignStatus, ColumnType, EmailJobStatus, Role } from '@prisma/client';
import { prisma } from '../lib/db/client';
import { linkContactsForDataset } from '../lib/records/contactLink';
import { loadCampaignForSession } from '../lib/campaigns/context';
import { startCampaignSend } from '../lib/campaigns/startSend';
import type { AppSession } from '../lib/auth/session';

// Production has no Redis: jobs wait in the database for the background sender.
delete process.env.REDIS_URL;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

/** Deletes everything a previous (interrupted) run of this script left behind. */
async function removeFixtures(userIds?: string[]) {
  const users = await prisma.user.findMany({ where: userIds ? { id: { in: userIds } } : { email: { startsWith: 'quick-send+' } }, select: { id: true } });
  for (const u of users) {
    const wss = (await prisma.workspace.findMany({ where: { ownerId: u.id }, select: { id: true } })).map((w) => w.id);
    const campaigns = (await prisma.campaign.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((c) => c.id);
    await prisma.emailJob.deleteMany({ where: { campaignId: { in: campaigns } } });
    await prisma.batch.deleteMany({ where: { campaignId: { in: campaigns } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaigns } } });
    const templates = (await prisma.template.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((t) => t.id);
    await prisma.templateVersion.deleteMany({ where: { templateId: { in: templates } } });
    await prisma.template.deleteMany({ where: { id: { in: templates } } });
    await prisma.dataset.deleteMany({ where: { workspaceId: { in: wss } } });
    await prisma.contact.deleteMany({ where: { workspaceId: { in: wss } } });
    await prisma.emailProviderAccount.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } });
    await prisma.workspace.deleteMany({ where: { id: { in: wss } } });
    await prisma.user.delete({ where: { id: u.id } });
  }
  return users.length;
}

async function main() {
  console.log('=== Quick Send building blocks (real DB, nothing sent) ===\n');
  const leftover = await removeFixtures();
  if (leftover) console.log(`Removed ${leftover} leftover fixture user(s).\n`);
  const stamp = Date.now();
  const org = await prisma.organization.upsert({ where: { allowedDomain: 'masaischool.com' }, update: {}, create: { name: 'Masai School', allowedDomain: 'masaischool.com' } });
  const user = await prisma.user.create({ data: { organizationId: org.id, googleId: `qs-${stamp}`, email: `quick-send+${stamp}@masaischool.com`, name: 'Quick Send Tester', role: Role.ADMIN } });
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: user.id, name: `Quick send ${stamp}` } });
  const account = await prisma.emailProviderAccount.create({
    data: { organizationId: org.id, workspaceId: ws.id, userId: user.id, emailAddress: user.email, displayName: 'QS Tester', status: 'CONNECTED' },
  });
  const session: AppSession = { userId: user.id, organizationId: org.id, workspaceId: ws.id, homeWorkspaceId: ws.id, role: Role.ADMIN, status: 'ACTIVE', email: user.email, name: user.name };

  try {
    console.log('Bulk contact linking');
    const dataset = await prisma.dataset.create({
      data: {
        organizationId: org.id, workspaceId: ws.id, ownerId: user.id, name: 'QS list',
        columns: { create: [{ key: 'Name', label: 'Name', type: ColumnType.TEXT, order: 1 }, { key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 2 }] },
      },
    });
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => ({ Name: `Person ${i}`, Email: `qs${i}-${stamp}@Example.com` })),
      ...Array.from({ length: 3 }, (_, i) => ({ Name: `Bad ${i}`, Email: 'not-an-email' })),
      ...Array.from({ length: 2 }, (_, i) => ({ Name: `Dup ${i}`, Email: `qs${i}-${stamp}@example.com` })),
    ];
    await prisma.record.createMany({ data: rows.map((data) => ({ datasetId: dataset.id, data })) });
    const t0 = Date.now();
    const linked = await linkContactsForDataset({ organizationId: org.id, workspaceId: ws.id, datasetId: dataset.id });
    const ms = Date.now() - t0;
    const contacts = await prisma.contact.count({ where: { workspaceId: ws.id } });
    const unlinked = await prisma.record.count({ where: { datasetId: dataset.id, contactId: null } });
    check('every valid row is linked (duplicates share a contact)', linked === 52 && contacts === 50 && unlinked === 3, { linked, contacts, unlinked });
    check(`linking 55 rows is quick (${ms} ms)`, ms < 5000, ms);
    const again = await linkContactsForDataset({ organizationId: org.id, workspaceId: ws.id, datasetId: dataset.id });
    check('running it again changes nothing', again === 0, again);

    console.log('\nBulk send snapshot (scheduled a year out: nothing goes out)');
    const template = await prisma.template.create({
      data: {
        organizationId: org.id, workspaceId: ws.id, ownerId: user.id, name: 'QS template',
        versions: { create: { version: 1, subject: 'Hi {{Name}}', html: '<p>Hello {{Name}}</p>', plainText: 'Hello {{Name}}', variables: ['Name'], createdById: user.id } },
      },
      include: { versions: true },
    });
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: org.id, workspaceId: ws.id, name: 'QS campaign', description: 'Quick Send', datasetId: dataset.id,
        templateId: template.id, templateVersionId: template.versions[0]!.id, createdById: user.id, status: CampaignStatus.DRAFT, ccEmails: ['placements@example.com'],
      },
    });
    const loaded = await loadCampaignForSession(session, campaign.id);
    const t1 = Date.now();
    const result = await startCampaignSend({ campaign: loaded!, actor: session, skipApproval: true, scheduledAt: new Date(Date.now() + 365 * 86_400_000), via: 'smoke-test' });
    const ms2 = Date.now() - t1;
    check('send accepted and scheduled', result.ok && (result.body as any).scheduled === true, result.body);
    const jobs = await prisma.emailJob.findMany({ where: { campaignId: campaign.id }, select: { toEmail: true, subject: true, ccEmails: true, status: true, fromEmail: true, emailProviderAccountId: true } });
    check('one email per unique valid address (50)', jobs.length === 50, jobs.length);
    check('each email personalised, with the Cc and the sender snapshot', jobs.every((j) => /^Hi Person \d+$/.test(j.subject) && j.ccEmails[0] === 'placements@example.com' && j.fromEmail === user.email && j.emailProviderAccountId === account.id && j.status === EmailJobStatus.QUEUED), jobs[0]);
    const queuedRecords = await prisma.record.count({ where: { datasetId: dataset.id, emailStatus: 'QUEUED' } });
    check('the 50 rows are marked queued', queuedRecords === 50, queuedRecords);
    const reasons = await prisma.record.findMany({ where: { datasetId: dataset.id, lastEmailError: { not: null } }, select: { lastEmailError: true } });
    check('skipped rows record why (3 invalid + 2 duplicates)', reasons.length === 5, reasons.map((r) => r.lastEmailError));
    const after = await prisma.campaign.findUnique({ where: { id: campaign.id }, select: { status: true } });
    const batch = await prisma.batch.findFirst({ where: { campaignId: campaign.id }, select: { status: true, validCount: true, skippedCount: true } });
    check('campaign scheduled; batch counts right', after?.status === CampaignStatus.SCHEDULED && batch?.validCount === 50 && batch?.skippedCount === 5 && batch.status === BatchStatus.PREPARING, { after, batch });
    check(`snapshot of 55 rows is quick (${ms2} ms)`, ms2 < 15000, ms2);
  } finally {
    await removeFixtures([user.id]);
    console.log('\nFixtures removed.');
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
