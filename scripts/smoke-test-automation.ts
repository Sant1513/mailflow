/**
 * End-to-end automation test against the REAL database.
 *
 * Proves the whole chain fires: a record edit triggers evaluation, stop
 * conditions and frequency policy are honoured, the SEND_EMAIL action
 * queues a real EmailJob with a full "why was this sent" trail, and every
 * decision — including the no-ops — is written to the run log.
 *
 * Usage: npx tsx scripts/smoke-test-automation.ts
 */
import { prisma } from '../lib/db/client';
import { evaluateAutomationForRecord, onRecordChanged, previewImpact } from '../lib/automation/runner';
import { Role, ColumnType, EmailProvider as EmailProviderEnum } from '@prisma/client';

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

async function main() {
  console.log('=== MailFlow automation test (real DB) ===\n');
  const stamp = Date.now();

  const org = await prisma.organization.upsert({
    where: { allowedDomain: 'masaischool.com' },
    update: {},
    create: { name: 'Masai School', allowedDomain: 'masaischool.com' },
  });

  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      googleId: `auto-smoke-${stamp}`,
      email: `auto-smoke+${stamp}@masaischool.com`,
      name: 'Automation Smoke User',
      role: Role.OPERATOR,
    },
  });
  const workspace = await prisma.workspace.create({
    data: { organizationId: org.id, ownerId: user.id, name: 'Automation Smoke WS' },
  });
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
      name: 'Automation Smoke Dataset',
      columns: {
        create: [
          { key: 'Name', label: 'Name', type: ColumnType.TEXT, order: 1 },
          { key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 2 },
          { key: 'Code', label: 'Code', type: ColumnType.TEXT, order: 3 },
          { key: 'Status', label: 'Status', type: ColumnType.STATUS, order: 4 },
          { key: 'Trigger', label: 'Trigger', type: ColumnType.NUMBER, order: 5 },
          { key: 'ReplyReceived', label: 'ReplyReceived', type: ColumnType.TEXT, order: 6 },
        ],
      },
    },
  });

  const template = await prisma.template.create({
    data: {
      organizationId: org.id,
      workspaceId: workspace.id,
      ownerId: user.id,
      name: 'RPG Clearance Reminder',
      versions: {
        create: {
          version: 1,
          subject: 'Reminder for {{Name}} — code {{Code}}',
          html: '<p>Dear {{Name}}, clear your RPG. Code: {{Code}}</p>',
          plainText: 'Dear {{Name}}, clear your RPG. Code: {{Code}}',
          variables: ['Name', 'Code'],
          createdById: user.id,
        },
      },
    },
    include: { versions: true },
  });

  // §124 sample automation: Trigger = 1 AND Status = Pending, stop if replied.
  const automation = await prisma.automation.create({
    data: {
      organizationId: org.id,
      workspaceId: workspace.id,
      datasetId: dataset.id,
      name: 'RPG Reminder',
      enabled: false,
      versions: {
        create: {
          version: 1,
          triggerType: 'RECORD_MATCHES_CONDITIONS',
          triggerConfig: {},
          conditions: {
            op: 'AND',
            rules: [
              { field: 'Trigger', operator: 'equals', value: 1 },
              { field: 'Status', operator: 'equals', value: 'Pending' },
            ],
          },
          stopConditions: {
            op: 'OR',
            rules: [
              { field: 'ReplyReceived', operator: 'equals', value: 'Yes' },
              { field: 'Status', operator: 'equals', value: 'Completed' },
            ],
          },
          actions: [{ type: 'SEND_EMAIL', config: { templateId: template.id } }],
          frequencyPolicy: { mode: 'ONCE' },
          createdById: user.id,
        },
      },
    },
    include: { versions: true },
  });
  const version = automation.versions[0]!;

  // Records covering each outcome.
  const matching = await prisma.record.create({
    data: { datasetId: dataset.id, data: { Name: 'Rahul', Email: `rahul-${stamp}@example.com`, Code: 'fd41', Status: 'Pending', Trigger: 1, ReplyReceived: 'No' } },
  });
  const notMatching = await prisma.record.create({
    data: { datasetId: dataset.id, data: { Name: 'Priya', Email: `priya-${stamp}@example.com`, Code: 'fd39', Status: 'Completed', Trigger: 1, ReplyReceived: 'No' } },
  });
  const replied = await prisma.record.create({
    data: { datasetId: dataset.id, data: { Name: 'Amit', Email: `amit-${stamp}@example.com`, Code: 'fd12', Status: 'Pending', Trigger: 1, ReplyReceived: 'Yes' } },
  });

  // ── Impact preview (§74) ──
  console.log('-- Impact preview (§74) --');
  const impact = await previewImpact(version, dataset.id);
  check('Preview counts only the matching record', impact.potentialRecords === 1, impact);
  check('Preview reports the total record count', impact.totalRecords === 3, impact.totalRecords);
  check('Preview describes the condition in words', impact.conditionText === 'Trigger = 1 AND Status = Pending', impact.conditionText);

  // ── Disabled automation does nothing ──
  console.log('\n-- Disabled automation (§74) --');
  const whileDisabled = await evaluateAutomationForRecord({
    automationId: automation.id,
    recordId: matching.id,
    triggerType: 'RECORD_UPDATED',
  });
  check('A disabled automation does not act', whileDisabled.result === 'SKIPPED', whileDisabled);
  check('Reason explains it is disabled', whileDisabled.reason.includes('disabled'), whileDisabled.reason);

  const jobsWhileDisabled = await prisma.emailJob.count({ where: { record: { datasetId: dataset.id } } });
  check('No email queued while disabled', jobsWhileDisabled === 0, jobsWhileDisabled);

  await prisma.automation.update({ where: { id: automation.id }, data: { enabled: true } });

  // ── Conditions ──
  console.log('\n-- Conditions (§69) --');
  const noMatch = await evaluateAutomationForRecord({
    automationId: automation.id,
    recordId: notMatching.id,
    triggerType: 'RECORD_UPDATED',
  });
  check('Non-matching record is skipped', noMatch.result === 'SKIPPED' && !noMatch.conditionsMet, noMatch);

  // ── Stop conditions (§71) ──
  console.log('\n-- Stop conditions (§71) --');
  const stopped = await evaluateAutomationForRecord({
    automationId: automation.id,
    recordId: replied.id,
    triggerType: 'RECORD_UPDATED',
  });
  check('Record that already replied is stopped', stopped.result === 'SKIPPED', stopped);
  check('Stop reason names the matched condition', stopped.reason.includes('Stop condition met'), stopped.reason);

  // ── The matching record fires ──
  console.log('\n-- Action fires (§70) --');
  const fired = await evaluateAutomationForRecord({
    automationId: automation.id,
    recordId: matching.id,
    triggerType: 'RECORD_UPDATED',
  });
  check('Matching record triggers the automation', fired.result === 'TRIGGERED', fired);
  check('Action reports the queued email', (fired.actionTaken ?? '').includes('SEND_EMAIL(queued'), fired.actionTaken);

  const job = await prisma.emailJob.findFirst({ where: { recordId: matching.id }, include: { campaign: true } });
  check('An EmailJob was queued', !!job, job?.id);
  check('Email addressed to the record email column', job?.toEmail === `rahul-${stamp}@example.com`, job?.toEmail);
  check('Subject personalized from the record', job?.subject === 'Reminder for Rahul — code fd41', job?.subject);
  check('Body personalized from the record', job?.html.includes('fd41') ?? false);
  check('Campaign is linked to the automation', job?.campaign.automationId === automation.id);
  check('Send reason names the automation (§35)', job?.sendReason?.includes('Automation: RPG Reminder') ?? false, job?.sendReason);
  check('Send reason names the matched condition (§35)', job?.sendReason?.includes('Trigger = 1 AND Status = Pending ✓') ?? false, job?.sendReason);

  // ── Frequency policy (§37) ──
  console.log('\n-- Send frequency (§37) --');
  // Mark the queued job as sent so the ONCE policy sees a prior send.
  await prisma.emailJob.update({ where: { id: job!.id }, data: { status: 'SENT', sentAt: new Date() } });

  const secondFire = await evaluateAutomationForRecord({
    automationId: automation.id,
    recordId: matching.id,
    triggerType: 'RECORD_UPDATED',
  });
  check('ONCE policy blocks a second send', secondFire.result === 'SKIPPED', secondFire);
  check('Frequency reason explains why', secondFire.reason.includes('once per record'), secondFire.reason);

  const jobCount = await prisma.emailJob.count({ where: { recordId: matching.id } });
  check('Still only one email job for that record', jobCount === 1, jobCount);

  // ── onRecordChanged dispatch ──
  console.log('\n-- Trigger dispatch --');
  const fresh = await prisma.record.create({
    data: { datasetId: dataset.id, data: { Name: 'Neha', Email: `neha-${stamp}@example.com`, Code: 'fd77', Status: 'Pending', Trigger: 1, ReplyReceived: 'No' } },
  });
  const dispatched = await onRecordChanged({
    recordId: fresh.id,
    datasetId: dataset.id,
    workspaceId: workspace.id,
    triggerType: 'RECORD_CREATED',
  });
  check('onRecordChanged evaluates the enabled automation', dispatched.length === 1, dispatched.length);
  check('New matching record fires', dispatched[0]?.result === 'TRIGGERED', dispatched[0]);

  // ── Run log (§72) ──
  console.log('\n-- Run log (§72) --');
  const runs = await prisma.automationRun.findMany({ where: { automationId: automation.id }, orderBy: { createdAt: 'asc' } });
  check('Every evaluation is logged, including the no-ops', runs.length === 6, runs.length);
  check('Log records both TRIGGERED and SKIPPED outcomes',
    runs.some((r) => r.result === 'TRIGGERED') && runs.some((r) => r.result === 'SKIPPED'));
  check('Each run references the version that made the decision (§73)',
    runs.every((r) => r.automationVersionId === version.id));

  // ── Versioning (§73) ──
  console.log('\n-- Versioning (§73) --');
  const v2 = await prisma.automationVersion.create({
    data: {
      automationId: automation.id,
      version: 2,
      triggerType: 'RECORD_MATCHES_CONDITIONS',
      triggerConfig: {},
      conditions: { op: 'AND', rules: [{ field: 'Trigger', operator: 'equals', value: 1 }] },
      actions: [{ type: 'SEND_EMAIL', config: { templateId: template.id } }],
      frequencyPolicy: { mode: 'ONCE' },
      createdById: user.id,
    },
  });
  const v1After = await prisma.automationVersion.findUniqueOrThrow({ where: { id: version.id } });
  check('v1 configuration is unchanged after v2 is created',
    JSON.stringify(v1After.conditions) === JSON.stringify(version.conditions));
  check('Historical runs still point at v1, not v2',
    runs.every((r) => r.automationVersionId !== v2.id));

  // ── Cleanup ──
  console.log('\n-- Cleanup --');
  await prisma.automationRun.deleteMany({ where: { automationId: automation.id } });
  await prisma.automationVersion.deleteMany({ where: { automationId: automation.id } });
  await prisma.emailJob.deleteMany({ where: { record: { datasetId: dataset.id } } });
  await prisma.batch.deleteMany({ where: { campaign: { workspaceId: workspace.id } } });
  await prisma.automation.delete({ where: { id: automation.id } });
  await prisma.campaign.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.templateVersion.deleteMany({ where: { templateId: template.id } });
  await prisma.template.delete({ where: { id: template.id } });
  await prisma.recordChangeHistory.deleteMany({ where: { record: { datasetId: dataset.id } } });
  await prisma.record.deleteMany({ where: { datasetId: dataset.id } });
  await prisma.datasetColumn.deleteMany({ where: { datasetId: dataset.id } });
  await prisma.dataset.delete({ where: { id: dataset.id } });
  await prisma.notification.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.contact.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.emailProviderAccount.delete({ where: { id: account.id } });
  await prisma.workspaceMember.deleteMany({ where: { userId: user.id } });
  await prisma.workspace.delete({ where: { id: workspace.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log('  ✓ all automation-test rows removed');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error('AUTOMATION SMOKE TEST CRASHED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
