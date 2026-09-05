/**
 * Sends ONE REAL EMAIL through the full campaign pipeline, to prove the
 * end-to-end path works: dataset -> template -> campaign -> dry run ->
 * batch -> EmailJob -> Gmail -> conversation + history.
 *
 * This is not a mock. It uses the real GmailProvider and will actually
 * deliver mail, so it requires a connected Gmail account (Settings ->
 * Connect Gmail) and refuses to run without one.
 *
 * Usage:
 *   npx tsx scripts/send-test-batch.ts <recipient@example.com>
 *   npx tsx scripts/send-test-batch.ts <recipient@example.com> --dry-run
 *
 * --dry-run performs every step except the send, so you can inspect what
 * would go out first.
 */
import { prisma } from '../lib/db/client';
import { dryRun } from '../lib/campaigns/evaluate';
import { renderTemplate } from '../lib/templates/variables';
import { processEmailJob, reconcileBatchStatus } from '../lib/email/processJob';
import { drainBatch } from '../lib/queue/drain';
import {
  ColumnType,
  CampaignStatus,
  BatchStatus,
  EmailJobStatus,
  EmailProvider as EmailProviderEnum,
} from '@prisma/client';

const recipient = process.argv[2];
const isDryRun = process.argv.includes('--dry-run');

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const TEMPLATE_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:24px 32px;border-bottom:1px solid #e6e9ee;">
        <strong style="font-size:16px;color:#12263f;">MailFlow</strong>
      </td></tr>
      <tr><td style="padding:32px;color:#3c4858;font-size:14px;line-height:1.6;">
        <p style="margin:0 0 16px;">Hi {{Name}},</p>
        <p style="margin:0 0 16px;">
          This message was sent by MailFlow through the full campaign pipeline:
          dataset &rarr; template &rarr; campaign &rarr; dry run &rarr; batch &rarr; queue &rarr; Gmail API.
        </p>
        <p style="margin:0 0 16px;">Your reference code is <strong>{{Code}}</strong>.</p>
        <p style="margin:0;">Regards,<br />MailFlow</p>
      </td></tr>
      <tr><td style="padding:16px 32px;background:#f4f6f8;color:#8492a6;font-size:12px;">
        Sent from MailFlow as a delivery test.
      </td></tr>
    </table>
  </td></tr>
</table>`;

async function main() {
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    fail('Usage: npx tsx scripts/send-test-batch.ts <recipient@example.com> [--dry-run]');
  }

  console.log(`=== MailFlow test batch -> ${recipient}${isDryRun ? '  (DRY RUN)' : ''} ===\n`);

  // ── 1. A connected sender is mandatory ──
  const sender = await prisma.emailProviderAccount.findFirst({
    where: { provider: EmailProviderEnum.GMAIL, status: 'CONNECTED', refreshTokenEnc: { not: null } },
    include: { user: true, workspace: true },
  });

  if (!sender) {
    const anyAccount = await prisma.emailProviderAccount.findFirst();
    fail(
      anyAccount
        ? `Found a Gmail account (${anyAccount.emailAddress}) but it is "${anyAccount.status}" or has no refresh token.\n` +
            `  Reconnect it at /settings before running this.`
        : 'No Gmail account is connected.\n' +
            '  1. Sign in to the app\n' +
            '  2. Go to Settings -> Connect Gmail and complete Google consent\n' +
            '  3. Re-run this script'
    );
  }

  console.log(`Sender:    ${sender.emailAddress} (${sender.user.name})`);
  console.log(`Workspace: ${sender.workspace.name}\n`);

  const owner = sender.user;
  const workspace = sender.workspace;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // ── 2. Dataset with the single recipient ──
  const dataset = await prisma.dataset.create({
    data: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: `Delivery test ${stamp}`,
      description: `One-recipient test batch to ${recipient}`,
      columns: {
        create: [
          { key: 'Name', label: 'Name', type: ColumnType.TEXT, order: 1 },
          { key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 2 },
          { key: 'Code', label: 'Code', type: ColumnType.TEXT, order: 3 },
        ],
      },
    },
  });

  const contact = await prisma.contact.upsert({
    where: { workspaceId_primaryEmail: { workspaceId: workspace.id, primaryEmail: recipient.toLowerCase() } },
    update: {},
    create: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      primaryEmail: recipient.toLowerCase(),
      name: recipient.split('@')[0],
    },
  });

  const record = await prisma.record.create({
    data: {
      datasetId: dataset.id,
      contactId: contact.id,
      data: { Name: recipient.split('@')[0], Email: recipient, Code: `MF-${Date.now().toString().slice(-6)}` },
    },
  });
  console.log(`✓ Dataset created with 1 record`);

  // ── 3. Template ──
  const template = await prisma.template.create({
    data: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: `Delivery test template ${stamp}`,
      versions: {
        create: {
          version: 1,
          subject: 'MailFlow delivery test — {{Code}}',
          html: TEMPLATE_HTML,
          plainText: 'Hi {{Name}}, this is a MailFlow delivery test. Reference: {{Code}}.',
          variables: ['Name', 'Code'],
          createdById: owner.id,
        },
      },
    },
    include: { versions: true },
  });
  const version = template.versions[0]!;
  console.log(`✓ Template created (v${version.version})`);

  // ── 4. Campaign, pinned to that template version ──
  const campaign = await prisma.campaign.create({
    data: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      name: `Delivery test ${stamp}`,
      datasetId: dataset.id,
      templateId: template.id,
      templateVersionId: version.id,
      createdById: owner.id,
      senderAccountId: sender.id,
      status: CampaignStatus.APPROVED,
      approvedById: owner.id,
      approvedAt: new Date(),
    },
  });
  console.log(`✓ Campaign created and approved`);

  // ── 5. Dry run — same evaluator the real send uses ──
  const label = `BATCH-TEST-${stamp}`;
  const simulation = dryRun(
    [{ id: record.id, data: record.data as Record<string, unknown> }],
    {
      emailColumnKey: 'Email',
      template: { subject: version.subject, html: version.html, plainText: version.plainText },
      origin: {
        campaignName: campaign.name,
        templateName: template.name,
        templateVersion: version.version,
        batchLabel: label,
        senderEmail: sender.emailAddress,
      },
    }
  );

  console.log(`\n--- Dry run ---`);
  console.log(`  evaluated: ${simulation.total}   would send: ${simulation.wouldSend}   skipped: ${simulation.skipped}`);
  for (const e of simulation.evaluations) {
    console.log(`  ${e.email}: ${e.willSend ? 'WOULD SEND' : `SKIP (${e.skipReason})`} — ${e.reasonDetail}`);
  }

  if (simulation.wouldSend !== 1) {
    fail('Dry run did not resolve exactly one sendable recipient — aborting before any send.');
  }

  const evaluation = simulation.evaluations.find((e) => e.willSend)!;
  const rendered = renderTemplate(
    { subject: version.subject, html: version.html, plainText: version.plainText },
    record.data as Record<string, unknown>
  );

  console.log(`\n--- Message preview ---`);
  console.log(`  From:    ${sender.displayName ?? owner.name} <${sender.emailAddress}>`);
  console.log(`  To:      ${evaluation.email}`);
  console.log(`  Subject: ${rendered.subject}`);
  console.log(`\n--- Why this is being sent (§35) ---`);
  console.log(evaluation.sendReason?.split('\n').map((l) => `  ${l}`).join('\n'));

  // ── 6. Batch + job ──
  const batch = await prisma.batch.create({
    data: {
      campaignId: campaign.id,
      label,
      status: BatchStatus.QUEUED,
      total: simulation.total,
      validCount: simulation.wouldSend,
      skippedCount: simulation.skipped,
    },
  });

  const job = await prisma.emailJob.create({
    data: {
      batchId: batch.id,
      campaignId: campaign.id,
      recordId: record.id,
      templateVersionId: version.id,
      emailProviderAccountId: sender.id,
      status: EmailJobStatus.QUEUED,
      toEmail: evaluation.email!,
      ccEmails: [],
      bccEmails: [],
      fromName: sender.displayName ?? owner.name,
      fromEmail: sender.emailAddress,
      subject: rendered.subject,
      html: rendered.html,
      plainText: rendered.plainText,
      sendReason: evaluation.sendReason,
    },
  });
  console.log(`\n✓ Batch ${label} created with 1 queued job`);

  if (isDryRun) {
    console.log('\n--dry-run set: stopping before the send. Nothing was emailed.');
    console.log(`   Batch ${batch.id} is left QUEUED; re-run without --dry-run to deliver it.`);
    return;
  }

  // ── 7. Send for real ──
  console.log(`\n--- Sending via Gmail API ---`);
  const outcome = await processEmailJob(job.id).catch((err) => ({
    status: 'FAILED' as const,
    emailJobId: job.id,
    reason: err?.message ?? String(err),
    retryable: true,
  }));

  await reconcileBatchStatus(batch.id);

  const finalJob = await prisma.emailJob.findUniqueOrThrow({ where: { id: job.id } });
  const finalBatch = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });

  if (finalJob.status === EmailJobStatus.SENT) {
    console.log(`\n✓ SENT to ${finalJob.toEmail}`);
    console.log(`  Gmail message id: ${finalJob.gmailMessageId}`);
    console.log(`  Gmail thread id:  ${finalJob.gmailThreadId}`);
    console.log(`  Message-ID:       ${finalJob.messageIdHeader}`);
    console.log(`  Sent at:          ${finalJob.sentAt?.toISOString()}`);

    const conversation = await prisma.conversation.findFirst({
      where: { emailProviderAccountId: sender.id, gmailThreadId: finalJob.gmailThreadId },
      include: { messages: true },
    });
    console.log(`\n  Conversation created: ${conversation ? 'yes' : 'no'} (${conversation?.messages.length ?? 0} message)`);
    console.log(`  Batch status:         ${finalBatch.status}`);
    console.log(`\n  Check the inbox of ${recipient} — and your Gmail "Sent" folder.`);
  } else {
    console.log(`\n✗ NOT SENT — job status ${finalJob.status}`);
    console.log(`  error code:    ${finalJob.errorCode}`);
    console.log(`  error message: ${finalJob.errorMessage}`);
    console.log(`  outcome:       ${JSON.stringify(outcome)}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error('TEST BATCH CRASHED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
