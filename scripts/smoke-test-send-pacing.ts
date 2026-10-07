/**
 * Send pacing and claiming against the REAL database with a fake provider
 * (no email leaves). Uses its own fixture user, mailboxes and batches only;
 * it calls drainBatch on those batches and never the global worker, so real
 * queued campaigns are untouched.
 *
 * Checks: emails from one mailbox go out at least 3 s apart; two senders
 * working the same batch at once never send anyone a duplicate; a paused
 * batch stops and its jobs stay queued.
 *
 * Usage: npx tsx scripts/smoke-test-send-pacing.ts
 */
import 'dotenv/config';
import { prisma } from '../lib/db/client';
import { drainBatch, sendGapMs } from '../lib/queue/drain';
import type { EmailProvider } from '../lib/email/provider';
import { BatchStatus, CampaignStatus, EmailJobStatus, EmailProvider as EmailProviderEnum, Role } from '@prisma/client';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

function fakeProvider() {
  const sent: { to: string; at: number }[] = [];
  const factory = (): EmailProvider => ({
    name: 'fake',
    async sendEmail(input) {
      await new Promise((r) => setTimeout(r, 300)); // a send takes a moment
      sent.push({ to: String(input.to), at: Date.now() });
      return { providerMessageId: `fake-${sent.length}-${Math.random()}`, threadId: `t-${sent.length}`, messageIdHeader: `<fake-${Date.now()}-${Math.random()}@test>` };
    },
  });
  return { factory, sent };
}

async function main() {
  console.log(`=== Send pacing test (gap ${sendGapMs()} ms, fake provider) ===\n`);
  const stamp = Date.now();
  const org = await prisma.organization.upsert({ where: { allowedDomain: 'masaischool.com' }, update: {}, create: { name: 'Masai School', allowedDomain: 'masaischool.com' } });
  const user = await prisma.user.create({ data: { organizationId: org.id, googleId: `pacing-${stamp}`, email: `pacing+${stamp}@masaischool.com`, name: 'Pacing Tester', role: Role.OPERATOR } });
  const workspace = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: user.id, name: `Pacing ${stamp}` } });
  const mkAccount = (n: number) =>
    prisma.emailProviderAccount.create({
      data: { organizationId: org.id, workspaceId: workspace.id, userId: user.id, provider: EmailProviderEnum.GMAIL, emailAddress: `pacing${n}+${stamp}@masaischool.com`, status: 'CONNECTED' },
    });
  // Accounts are unique per (workspace, user, provider): a second workspace holds the second mailbox.
  const accountA = await mkAccount(1);
  const workspace2 = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: user.id, name: `Pacing B ${stamp}` } });
  const accountB = await prisma.emailProviderAccount.create({
    data: { organizationId: org.id, workspaceId: workspace2.id, userId: user.id, provider: EmailProviderEnum.GMAIL, emailAddress: `pacing2+${stamp}@masaischool.com`, status: 'CONNECTED' },
  });
  const dataset = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: workspace.id, ownerId: user.id, name: 'Pacing data' } });
  const template = await prisma.template.create({
    data: {
      organizationId: org.id, workspaceId: workspace.id, ownerId: user.id, name: 'Pacing template',
      versions: { create: { version: 1, subject: 'Pacing', html: '<p>x</p>', plainText: 'x', variables: [], createdById: user.id } },
    },
    include: { versions: true },
  });
  const version = template.versions[0]!;
  const campaign = await prisma.campaign.create({
    data: { organizationId: org.id, workspaceId: workspace.id, name: 'Pacing campaign', datasetId: dataset.id, templateId: template.id, templateVersionId: version.id, createdById: user.id, status: CampaignStatus.RUNNING, senderAccountId: accountA.id },
  });

  const mkBatch = async (label: string, n: number, accountId: string) => {
    const batch = await prisma.batch.create({ data: { campaignId: campaign.id, label: `${label}-${stamp}`, status: BatchStatus.QUEUED, total: n, validCount: n, skippedCount: 0 } });
    for (let i = 0; i < n; i++) {
      const record = await prisma.record.create({ data: { datasetId: dataset.id, data: { Email: `${label}${i}-${stamp}@example.com` } } });
      await prisma.emailJob.create({
        data: {
          batchId: batch.id, campaignId: campaign.id, recordId: record.id, templateVersionId: version.id, emailProviderAccountId: accountId,
          status: EmailJobStatus.QUEUED, toEmail: `${label}${i}-${stamp}@example.com`, ccEmails: [], bccEmails: [], fromName: 'Pacing', fromEmail: 'pacing@test', subject: 'Pacing', html: '<p>x</p>',
        },
      });
    }
    return batch;
  };

  try {
    console.log('One sender, one mailbox');
    const a = await mkBatch('a', 4, accountA.id);
    const pa = fakeProvider();
    const t0 = Date.now();
    const ra = await drainBatch(a.id, { limit: 10, deadline: Date.now() + 50_000, providerFactory: pa.factory });
    const sentA = await prisma.emailJob.findMany({ where: { batchId: a.id, status: EmailJobStatus.SENT }, orderBy: { sentAt: 'asc' }, select: { sentAt: true } });
    const gaps = sentA.slice(1).map((j, i) => j.sentAt!.getTime() - sentA[i]!.sentAt!.getTime());
    check('all 4 sent', ra.sent === 4 && sentA.length === 4, ra);
    check(`every email at least ${sendGapMs() / 1000} s after the previous one`, gaps.every((g) => g >= sendGapMs() - 50), gaps);
    check('took about 3 s per email, not a burst', Date.now() - t0 >= 3 * (sendGapMs() - 50), Date.now() - t0);

    console.log('\nTwo senders on the same batch at once');
    const b = await mkBatch('b', 6, accountB.id);
    const pb = fakeProvider();
    const [r1, r2] = await Promise.all([
      drainBatch(b.id, { limit: 10, deadline: Date.now() + 55_000, providerFactory: pb.factory }),
      drainBatch(b.id, { limit: 10, deadline: Date.now() + 55_000, providerFactory: pb.factory }),
    ]);
    const recipients = pb.sent.map((s) => s.to);
    check('each of the 6 people emailed exactly once', recipients.length === 6 && new Set(recipients).size === 6, { recipients: recipients.length, unique: new Set(recipients).size, r1: r1.sent, r2: r2.sent });
    const leftB = await prisma.emailJob.count({ where: { batchId: b.id, status: { not: EmailJobStatus.SENT } } });
    check('no job left behind or stuck', leftB === 0, leftB);

    console.log('\nPause');
    const c = await mkBatch('c', 3, accountA.id);
    await prisma.batch.update({ where: { id: c.id }, data: { status: BatchStatus.PAUSED } });
    const pc = fakeProvider();
    const rc = await drainBatch(c.id, { limit: 10, providerFactory: pc.factory });
    const queuedC = await prisma.emailJob.count({ where: { batchId: c.id, status: EmailJobStatus.QUEUED } });
    check('a paused batch sends nothing and keeps its jobs queued', rc.sent === 0 && pc.sent.length === 0 && queuedC === 3, { rc, queuedC });
  } finally {
    await prisma.emailJob.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.batch.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.campaign.deleteMany({ where: { id: campaign.id } });
    await prisma.templateVersion.deleteMany({ where: { templateId: template.id } });
    await prisma.template.deleteMany({ where: { id: template.id } });
    await prisma.record.deleteMany({ where: { datasetId: dataset.id } });
    await prisma.dataset.deleteMany({ where: { id: dataset.id } });
    await prisma.emailProviderAccount.deleteMany({ where: { id: { in: [accountA.id, accountB.id] } } });
    await prisma.auditLog.deleteMany({ where: { actorId: user.id } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, workspace2.id] } } });
    await prisma.user.delete({ where: { id: user.id } });
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
