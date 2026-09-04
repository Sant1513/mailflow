/**
 * End-to-end send pipeline test against the REAL database, using a fake
 * email provider so no actual email is sent.
 *
 * Covers the parts that only exist once rows are on disk: batch creation,
 * immutable send snapshots, idempotency, pause/cancel, retry classification,
 * rate limiting, and conversation/history creation.
 *
 * Usage: npx tsx scripts/smoke-test-send.ts
 */
import { prisma } from '../lib/db/client';
import { processEmailJob, reconcileBatchStatus } from '../lib/email/processJob';
import { drainBatch } from '../lib/queue/drain';
import { SendEmailError, type EmailProvider } from '../lib/email/provider';
import { renderTemplate } from '../lib/templates/variables';
import { dryRun } from '../lib/campaigns/evaluate';
import {
  Role,
  ColumnType,
  CampaignStatus,
  BatchStatus,
  EmailJobStatus,
  EmailProvider as EmailProviderEnum,
} from '@prisma/client';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

/** A provider that records what it was asked to send, and can be told to fail. */
function makeFakeProvider(behaviour: { fail?: SendEmailError } = {}) {
  const sent: any[] = [];
  const factory = (): EmailProvider => ({
    name: 'fake',
    async sendEmail(input) {
      if (behaviour.fail) throw behaviour.fail;
      sent.push(input);
      return {
        providerMessageId: `fake-msg-${sent.length}`,
        threadId: `fake-thread-${sent.length}`,
        messageIdHeader: `<fake-${sent.length}@masaischool.com>`,
      };
    },
  });
  return { factory, sent };
}

async function main() {
  console.log('=== MailFlow send-pipeline test (real DB, fake provider) ===\n');

  const stamp = Date.now();
  const org = await prisma.organization.upsert({
    where: { allowedDomain: 'masaischool.com' },
    update: {},
    create: { name: 'Masai School', allowedDomain: 'masaischool.com' },
  });

  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      googleId: `send-smoke-${stamp}`,
      email: `send-smoke+${stamp}@masaischool.com`,
      name: 'Send Smoke User',
      role: Role.OPERATOR,
    },
  });
  const workspace = await prisma.workspace.create({
    data: { organizationId: org.id, ownerId: user.id, name: 'Send Smoke WS' },
  });

  // A connected sending account (no real tokens — the fake provider never
  // touches them).
  const account = await prisma.emailProviderAccount.create({
    data: {
      organizationId: org.id,
      workspaceId: workspace.id,
      userId: user.id,
      provider: EmailProviderEnum.GMAIL,
      emailAddress: user.email,
      displayName: user.name,
      status: 'CONNECTED',
    },
  });

  const dataset = await prisma.dataset.create({
    data: {
      organizationId: org.id,
      workspaceId: workspace.id,
      ownerId: user.id,
      name: 'Send Smoke Dataset',
      columns: {
        create: [
          { key: 'Name', label: 'Name', type: ColumnType.TEXT, order: 1 },
          { key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 2 },
          { key: 'Code', label: 'Code', type: ColumnType.TEXT, order: 3 },
        ],
      },
    },
    include: { columns: true },
  });

  const contacts = await Promise.all(
    ['alpha', 'beta', 'gamma'].map((n) =>
      prisma.contact.create({
        data: { organizationId: org.id, workspaceId: workspace.id, primaryEmail: `${n}-${stamp}@example.com`, name: n },
      })
    )
  );

  const records = await Promise.all([
    prisma.record.create({
      data: { datasetId: dataset.id, contactId: contacts[0]!.id, data: { Name: 'Alpha', Email: contacts[0]!.primaryEmail, Code: 'A1' } },
    }),
    prisma.record.create({
      data: { datasetId: dataset.id, contactId: contacts[1]!.id, data: { Name: 'Beta', Email: contacts[1]!.primaryEmail, Code: 'B2' } },
    }),
    // Deliberately broken: no Code, so the variable check must skip it.
    prisma.record.create({
      data: { datasetId: dataset.id, contactId: contacts[2]!.id, data: { Name: 'Gamma', Email: contacts[2]!.primaryEmail } },
    }),
    // Invalid address.
    prisma.record.create({ data: { datasetId: dataset.id, data: { Name: 'Delta', Email: 'not-an-email', Code: 'D4' } } }),
  ]);

  const template = await prisma.template.create({
    data: {
      organizationId: org.id,
      workspaceId: workspace.id,
      ownerId: user.id,
      name: 'Send Smoke Template',
      versions: {
        create: {
          version: 1,
          subject: 'Hello {{Name}} — code {{Code}}',
          html: '<p>Hi {{Name}}, your code is {{Code}}.</p>',
          plainText: 'Hi {{Name}}, your code is {{Code}}.',
          variables: ['Name', 'Code'],
          createdById: user.id,
        },
      },
    },
    include: { versions: true },
  });
  const version = template.versions[0]!;

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: org.id,
      workspaceId: workspace.id,
      name: 'Send Smoke Campaign',
      datasetId: dataset.id,
      templateId: template.id,
      templateVersionId: version.id,
      createdById: user.id,
      status: CampaignStatus.APPROVED,
      senderAccountId: account.id,
    },
  });

  // ── Dry run ──
  console.log('-- Dry run --');
  const evaluable = records.map((r) => ({ id: r.id, data: r.data as Record<string, unknown> }));
  const simulation = dryRun(evaluable, {
    emailColumnKey: 'Email',
    template: { subject: version.subject, html: version.html, plainText: version.plainText },
    // Mirrors what buildEvaluationContext supplies in the real send route.
    origin: {
      campaignName: 'Send Smoke Campaign',
      templateName: template.name,
      templateVersion: version.version,
      batchLabel: `BATCH-SMOKE-${stamp}`,
      senderEmail: account.emailAddress,
    },
  });
  check('Dry run evaluates all 4 records', simulation.total === 4, simulation.total);
  check('Dry run would send only the 2 valid records', simulation.wouldSend === 2, simulation.wouldSend);
  check('Dry run flags the missing-variable record', simulation.byReason.MISSING_VARIABLE === 1, simulation.byReason);
  check('Dry run flags the invalid address', simulation.byReason.INVALID_EMAIL === 1, simulation.byReason);

  const beforeJobs = await prisma.emailJob.count({ where: { campaignId: campaign.id } });
  check('Dry run created NO email jobs (nothing was sent)', beforeJobs === 0, beforeJobs);

  // ── Batch + job creation (mirrors the send route) ──
  console.log('\n-- Batch creation --');
  const batch = await prisma.batch.create({
    data: {
      campaignId: campaign.id,
      label: `BATCH-SMOKE-${stamp}`,
      status: BatchStatus.QUEUED,
      total: simulation.total,
      validCount: simulation.wouldSend,
      skippedCount: simulation.skipped,
    },
  });

  for (const evaluation of simulation.evaluations.filter((e) => e.willSend)) {
    const record = records.find((r) => r.id === evaluation.recordId)!;
    const rendered = renderTemplate(
      { subject: version.subject, html: version.html, plainText: version.plainText },
      record.data as Record<string, unknown>
    );
    await prisma.emailJob.create({
      data: {
        batchId: batch.id,
        campaignId: campaign.id,
        recordId: record.id,
        templateVersionId: version.id,
        emailProviderAccountId: account.id,
        status: EmailJobStatus.QUEUED,
        toEmail: evaluation.email!,
        ccEmails: [],
        bccEmails: [],
        fromName: user.name,
        fromEmail: account.emailAddress,
        subject: rendered.subject,
        html: rendered.html,
        plainText: rendered.plainText,
        sendReason: evaluation.sendReason,
      },
    });
  }

  const jobs = await prisma.emailJob.findMany({ where: { batchId: batch.id }, orderBy: { createdAt: 'asc' } });
  check('One email job created per sendable record', jobs.length === 2, jobs.length);
  check('Job stores the personalized subject snapshot', jobs[0]!.subject.includes('Alpha'), jobs[0]!.subject);
  check('Job stores the rendered HTML snapshot (§89)', jobs[0]!.html.includes('A1'), jobs[0]!.html);
  check('Job stores the sender snapshot (§30)', jobs[0]!.fromEmail === account.emailAddress);
  check('Job stores why it is being sent (§35)', !!jobs[0]!.sendReason && jobs[0]!.sendReason!.includes('Campaign:'), jobs[0]!.sendReason);

  // ── Sending via the real processor with a fake provider ──
  console.log('\n-- Sending --');
  const provider = makeFakeProvider();
  const outcome1 = await processEmailJob(jobs[0]!.id, { providerFactory: provider.factory });
  check('First job sends successfully', outcome1.status === 'SENT', outcome1);
  check('Provider received exactly one message', provider.sent.length === 1, provider.sent.length);
  check('Provider was given the personalized subject', provider.sent[0].subject.includes('Alpha'));

  const sentJob = await prisma.emailJob.findUniqueOrThrow({ where: { id: jobs[0]!.id } });
  check('Job marked SENT with provider ids recorded', sentJob.status === 'SENT' && !!sentJob.gmailMessageId && !!sentJob.gmailThreadId);
  check('Message-ID header stored for future threading (§46)', !!sentJob.messageIdHeader, sentJob.messageIdHeader);

  const recordAfter = await prisma.record.findUniqueOrThrow({ where: { id: jobs[0]!.recordId } });
  check('Record system email fields updated', recordAfter.emailStatus === 'SENT' && !!recordAfter.lastEmailSentAt);
  check('Record business data untouched (§14)', (recordAfter.data as any).Name === 'Alpha');

  const conversation = await prisma.conversation.findFirst({
    where: { emailProviderAccountId: account.id, gmailThreadId: sentJob.gmailThreadId },
    include: { messages: true },
  });
  check('Conversation created from the outbound send (§45)', !!conversation, conversation?.id);
  check('Outbound message recorded in the conversation', conversation?.messages.length === 1);
  check('Outbound message stores an immutable body snapshot (§89)', conversation?.messages[0]?.htmlBody?.includes('A1') ?? false);

  const history = await prisma.recipientHistory.findMany({ where: { contactId: contacts[0]!.id } });
  check('Recipient timeline entry created (§61)', history.length === 1, history.length);

  // ── Idempotency ──
  console.log('\n-- Idempotency (§41) --');
  const repeat = await processEmailJob(jobs[0]!.id, { providerFactory: provider.factory });
  check('Re-processing a SENT job does not send again', repeat.status === 'SKIPPED', repeat);
  check('Provider still saw only one message', provider.sent.length === 1, provider.sent.length);

  // ── Pause blocks sending ──
  console.log('\n-- Pause / cancel (§43) --');
  await prisma.batch.update({ where: { id: batch.id }, data: { status: BatchStatus.PAUSED } });
  const pausedOutcome = await processEmailJob(jobs[1]!.id, { providerFactory: provider.factory });
  check('A paused batch does not send', pausedOutcome.status === 'SKIPPED', pausedOutcome);
  check('Provider still saw only one message while paused', provider.sent.length === 1);

  const pausedDrain = await drainBatch(batch.id, { providerFactory: provider.factory });
  check('Draining a paused batch processes nothing', pausedDrain.processed === 0, pausedDrain);

  await prisma.batch.update({ where: { id: batch.id }, data: { status: BatchStatus.RUNNING } });

  // ── Drain processes the rest ──
  console.log('\n-- Drain --');
  const drained = await drainBatch(batch.id, { limit: 10, providerFactory: provider.factory });
  check('Drain sends the remaining queued job', drained.sent === 1, drained);
  check('Drain reports zero remaining afterwards', drained.remaining === 0, drained.remaining);
  check('Batch reconciles to COMPLETED', drained.batchStatus === BatchStatus.COMPLETED, drained.batchStatus);

  const campaignAfter = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
  check('Campaign marked COMPLETED', campaignAfter.status === CampaignStatus.COMPLETED, campaignAfter.status);

  // ── Failure handling ──
  console.log('\n-- Failure classification (§42) --');
  const failBatch = await prisma.batch.create({
    data: { campaignId: campaign.id, label: `BATCH-FAIL-${stamp}`, status: BatchStatus.RUNNING, total: 1, validCount: 1 },
  });
  // A record of its own, so this job doesn't collide with the idempotency
  // key of the ones already sent above.
  const failRecord = await prisma.record.create({
    data: { datasetId: dataset.id, data: { Name: 'Fail', Email: 'permanent-fail@example.com', Code: 'F' } },
  });
  const failJob = await prisma.emailJob.create({
    data: {
      batchId: failBatch.id,
      campaignId: campaign.id,
      recordId: failRecord.id,
      templateVersionId: version.id,
      emailProviderAccountId: account.id,
      status: EmailJobStatus.QUEUED,
      toEmail: 'permanent-fail@example.com',
      ccEmails: [],
      bccEmails: [],
      fromName: user.name,
      fromEmail: account.emailAddress,
      subject: 'x',
      html: '<p>x</p>',
    },
  });

  const failing = makeFakeProvider({ fail: new SendEmailError('bad address', 'INVALID_RECIPIENT') });
  const failOutcome = await processEmailJob(failJob.id, { providerFactory: failing.factory });
  check('Permanent failure is not retried', failOutcome.status === 'FAILED' && failOutcome.retryable === false, failOutcome);

  const failedJob = await prisma.emailJob.findUniqueOrThrow({ where: { id: failJob.id } });
  check('Failed job stores the error code and message', failedJob.errorCode === 'INVALID_RECIPIENT' && !!failedJob.errorMessage);
  check('Failed job increments retryCount', failedJob.retryCount === 1, failedJob.retryCount);

  const retryable = makeFakeProvider({ fail: new SendEmailError('slow down', 'RATE_LIMIT') });
  let threw = false;
  await prisma.emailJob.update({ where: { id: failJob.id }, data: { status: EmailJobStatus.QUEUED } });
  try {
    await processEmailJob(failJob.id, { providerFactory: retryable.factory });
  } catch {
    threw = true;
  }
  check('Retryable failure throws so the queue can back off', threw);

  // ── Idempotency key is enforced by the database ──
  console.log('\n-- Database-level duplicate protection (§41) --');
  let duplicateRejected = false;
  try {
    await prisma.emailJob.create({
      data: {
        batchId: batch.id,
        campaignId: campaign.id,
        recordId: records[0]!.id,
        templateVersionId: version.id,
        emailProviderAccountId: account.id,
        status: EmailJobStatus.QUEUED,
        toEmail: 'dup@example.com',
        ccEmails: [],
        bccEmails: [],
        fromName: 'x',
        fromEmail: account.emailAddress,
        subject: 'dup',
        html: '<p>dup</p>',
      },
    });
  } catch {
    duplicateRejected = true;
  }
  check('DB rejects a second job for the same (campaign, record, version)', duplicateRejected);

  // ── Cleanup ──
  console.log('\n-- Cleanup --');
  await prisma.conversationMessage.deleteMany({ where: { conversation: { workspaceId: workspace.id } } });
  await prisma.conversation.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.recipientHistory.deleteMany({ where: { contact: { workspaceId: workspace.id } } });
  await prisma.emailJob.deleteMany({ where: { campaignId: campaign.id } });
  await prisma.batch.deleteMany({ where: { campaignId: campaign.id } });
  await prisma.campaign.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.templateVersion.deleteMany({ where: { templateId: template.id } });
  await prisma.template.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.recordChangeHistory.deleteMany({ where: { record: { datasetId: dataset.id } } });
  await prisma.record.deleteMany({ where: { datasetId: dataset.id } });
  await prisma.datasetColumn.deleteMany({ where: { datasetId: dataset.id } });
  await prisma.dataset.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.contact.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.emailProviderAccount.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.auditLog.deleteMany({ where: { actorId: user.id } });
  await prisma.workspaceMember.deleteMany({ where: { userId: user.id } });
  await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log('  ✓ all send-test rows removed');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error('SEND SMOKE TEST CRASHED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
