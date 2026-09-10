/**
 * Builds a complete, realistic sample workspace for the signed-in user:
 * a dataset with a proper EMAIL column, linked contacts, a template, an
 * approved campaign, and a (disabled) automation.
 *
 * Creates nothing that sends. The campaign is left ready but unsent, and
 * the automation is left OFF, so nothing goes out without an explicit
 * action — §74.
 *
 * Also repairs any existing dataset whose email column was mis-typed as
 * TEXT by import inference, which otherwise leaves it unsendable.
 *
 * Usage: npx tsx scripts/seed-samples.ts [recipient@example.com]
 */
import { prisma } from '../lib/db/client';
import { linkContactsForDataset } from '../lib/records/contactLink';
import { ColumnType, CampaignStatus, Prisma } from '@prisma/client';

const RECIPIENT = process.argv[2] ?? 'abhisheshuu@gmail.com';

const SAMPLE_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:24px 32px;border-bottom:1px solid #e6e9ee;">
        <strong style="font-size:16px;color:#12263f;">Masai School</strong>
      </td></tr>
      <tr><td style="padding:32px;color:#3c4858;font-size:14px;line-height:1.6;">
        <p style="margin:0 0 16px;">Dear {{Name}},</p>
        <p style="margin:0 0 16px;">
          As you prepare for upcoming placement opportunities, please note it is
          mandatory to get your RPG cleared.
        </p>
        <p style="margin:0 0 8px;">Your code: <strong>{{Code}}</strong></p>
        <p style="margin:0 0 16px;">Deadline: <strong>{{Deadline}}</strong></p>
        <p style="margin:0;">Regards,<br />Placement Team<br />Masai School</p>
      </td></tr>
      <tr><td style="padding:16px 32px;background:#f4f6f8;color:#8492a6;font-size:12px;">
        Internal communication from Masai School.
      </td></tr>
    </table>
  </td></tr>
</table>`;

async function repairMistypedEmailColumns() {
  console.log('-- Repairing mis-typed email columns --');
  const datasets = await prisma.dataset.findMany({ include: { columns: true, records: { take: 25 } } });
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  for (const dataset of datasets) {
    if (dataset.columns.some((c) => c.type === ColumnType.EMAIL)) continue;
    if (dataset.records.length === 0) continue;

    // Find a non-EMAIL column whose values actually look like addresses.
    for (const column of dataset.columns) {
      const values = dataset.records
        .map((r) => (r.data as Record<string, unknown>)[column.key])
        .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      if (values.length === 0) continue;

      if (values.every((v) => EMAIL_RE.test(v.trim()))) {
        await prisma.datasetColumn.update({ where: { id: column.id }, data: { type: ColumnType.EMAIL } });
        const linked = await linkContactsForDataset({
          organizationId: dataset.organizationId,
          workspaceId: dataset.workspaceId,
          datasetId: dataset.id,
        });
        console.log(
          `  ✓ "${dataset.name}": column "${column.label}" held addresses but was ${column.type} — retyped to EMAIL, ${linked} contact(s) linked`
        );
        break;
      }
    }
  }
}

async function main() {
  console.log('=== MailFlow sample data ===\n');

  const user = await prisma.user.findFirst({
    include: { ownedWorkspaces: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!user || !user.ownedWorkspaces[0]) {
    console.error('No signed-in user found. Sign in to the app once, then re-run.');
    process.exit(1);
  }
  const workspace = user.ownedWorkspaces[0];
  console.log(`Workspace: ${workspace.name} (${user.email})\n`);

  await repairMistypedEmailColumns();

  // ── Dataset ──
  console.log('\n-- Sample dataset --');
  const existing = await prisma.dataset.findFirst({
    where: { workspaceId: workspace.id, name: 'Placement Students — Sample' },
  });
  if (existing) {
    await prisma.record.deleteMany({ where: { datasetId: existing.id } });
    await prisma.datasetColumn.deleteMany({ where: { datasetId: existing.id } });
    await prisma.dataset.delete({ where: { id: existing.id } });
    console.log('  (replaced the previous sample dataset)');
  }

  const dataset = await prisma.dataset.create({
    data: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      ownerId: user.id,
      name: 'Placement Students — Sample',
      description: 'Sample dataset created by scripts/seed-samples.ts',
      columns: {
        create: [
          { key: 'Name', label: 'Name', type: ColumnType.TEXT, order: 1 },
          { key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 2 },
          { key: 'Code', label: 'Code', type: ColumnType.TEXT, order: 3 },
          { key: 'Deadline', label: 'Deadline', type: ColumnType.TEXT, order: 4 },
          { key: 'Status', label: 'Status', type: ColumnType.STATUS, order: 5 },
          { key: 'Trigger', label: 'Trigger', type: ColumnType.NUMBER, order: 6 },
        ],
      },
    },
  });

  const rows = [
    { Name: 'Abhishesh', Email: RECIPIENT, Code: 'fd41_470074', Deadline: '16 April 2026', Status: 'Pending', Trigger: 1 },
    { Name: 'Rahul Sharma', Email: 'rahul@example.com', Code: 'fd39_246', Deadline: '16 April 2026', Status: 'Pending', Trigger: 1 },
    { Name: 'Priya Sharma', Email: 'priya@example.com', Code: 'fd12_881', Deadline: '16 April 2026', Status: 'Completed', Trigger: 0 },
    { Name: 'Amit Kumar', Email: 'amit@example.com', Code: 'fd77_320', Deadline: '20 April 2026', Status: 'Pending', Trigger: 1 },
    // Deliberately broken rows, so the dry run has something real to catch.
    { Name: 'Broken Address', Email: 'not-an-email', Code: 'fd00_000', Deadline: '20 April 2026', Status: 'Pending', Trigger: 1 },
    { Name: 'Missing Code', Email: 'nocode@example.com', Deadline: '20 April 2026', Status: 'Pending', Trigger: 1 },
  ];

  await prisma.record.createMany({
    data: rows.map((data) => ({ datasetId: dataset.id, data: data as Prisma.InputJsonValue })),
  });
  const linked = await linkContactsForDataset({
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    datasetId: dataset.id,
  });
  console.log(`  ✓ ${rows.length} records (2 intentionally invalid), ${linked} contacts linked`);

  // ── Template ──
  console.log('\n-- Sample template --');
  const templateName = 'RPG Clearance Reminder — Sample';
  await prisma.templateVersion.deleteMany({ where: { template: { workspaceId: workspace.id, name: templateName } } });
  await prisma.template.deleteMany({ where: { workspaceId: workspace.id, name: templateName } });

  const template = await prisma.template.create({
    data: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      ownerId: user.id,
      name: templateName,
      description: 'Sample template created by scripts/seed-samples.ts',
      versions: {
        create: {
          version: 1,
          subject: 'Reminder: RPG Clearance Required — {{Deadline}}',
          html: SAMPLE_HTML,
          plainText:
            'Dear {{Name}},\n\nIt is mandatory to get your RPG cleared.\n\nYour code: {{Code}}\nDeadline: {{Deadline}}\n\nRegards,\nPlacement Team',
          variables: ['Name', 'Code', 'Deadline'],
          createdById: user.id,
        },
      },
    },
    include: { versions: true },
  });
  console.log(`  ✓ "${template.name}" v1 with variables {{Name}} {{Code}} {{Deadline}}`);

  // ── Campaign (ready, NOT sent) ──
  console.log('\n-- Sample campaign --');
  await prisma.campaign.deleteMany({
    where: { workspaceId: workspace.id, name: 'RPG Clearance Reminder — Sample' },
  });
  const campaign = await prisma.campaign.create({
    data: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      name: 'RPG Clearance Reminder — Sample',
      datasetId: dataset.id,
      templateId: template.id,
      templateVersionId: template.versions[0]!.id,
      createdById: user.id,
      status: CampaignStatus.DRAFT,
    },
  });
  console.log(`  ✓ "${campaign.name}" (DRAFT — nothing is sent until you send it)`);

  // ── Automation (OFF) ──
  console.log('\n-- Sample automation --');
  await prisma.automationVersion.deleteMany({
    where: { automation: { workspaceId: workspace.id, name: 'RPG Reminder — Sample' } },
  });
  await prisma.automation.deleteMany({ where: { workspaceId: workspace.id, name: 'RPG Reminder — Sample' } });

  const automation = await prisma.automation.create({
    data: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      datasetId: dataset.id,
      name: 'RPG Reminder — Sample',
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
            rules: [{ field: 'Status', operator: 'equals', value: 'Completed' }],
          },
          actions: [{ type: 'SEND_EMAIL', config: { templateId: template.id } }],
          frequencyPolicy: { mode: 'ONCE' },
          createdById: user.id,
        },
      },
    },
  });
  console.log(`  ✓ "${automation.name}" (OFF — enabling requires confirming the affected record count)`);

  console.log('\n=== Sample data ready ===');
  console.log(`  Dataset:    Placement Students — Sample (${rows.length} records)`);
  console.log(`  Template:   ${template.name}`);
  console.log(`  Campaign:   ${campaign.name} (draft)`);
  console.log(`  Automation: ${automation.name} (off)`);
  console.log('\nNothing has been emailed. To actually send one message, run:');
  console.log(`  npx tsx scripts/send-test-batch.ts ${RECIPIENT}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
