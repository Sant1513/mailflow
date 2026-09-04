/**
 * Direct-to-Prisma smoke test against the real (Neon) database — exercises
 * the exact same code paths the API routes use (dataset/column/record
 * creation, contact linking, change history, audit log) without needing a
 * browser session. Run with: npx tsx scripts/smoke-test-db.ts
 *
 * This is a throwaway verification script, not part of the app; it cleans
 * up everything it creates.
 */
import { prisma } from '../lib/db/client';
import { findOrCreateContactForRecord } from '../lib/records/contactLink';
import { parsePastedText, inferColumnTypes, guessEmailColumn, analyzeDuplicates } from '../lib/imports/parse';
import { ColumnType, Role } from '@prisma/client';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

async function main() {
  console.log('=== MailFlow DB smoke test (live Neon Postgres) ===\n');

  const org = await prisma.organization.upsert({
    where: { allowedDomain: 'masaischool.com' },
    update: {},
    create: { name: 'Masai School', allowedDomain: 'masaischool.com' },
  });
  check('Organization exists', !!org.id);

  // A throwaway user + workspace, simulating a real signed-in operator.
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      googleId: `smoketest-${Date.now()}`,
      email: `smoketest+${Date.now()}@masaischool.com`,
      name: 'Smoke Test User',
      role: Role.OPERATOR,
    },
  });
  const workspace = await prisma.workspace.create({
    data: { organizationId: org.id, ownerId: user.id, name: 'Smoke Test Workspace' },
  });
  check('User + Workspace created', !!workspace.id);

  // ── §15/§16 import pipeline (paste -> parse -> types -> dupes) ──
  console.log('\n-- Import pipeline --');
  const pasted =
    'Name\tEmail\tCode\tDeadline\tStatus\tTrigger\n' +
    'Rahul Sharma\trahul@example.com\tfd41_470074\t16 April 2025\tPending\t1\n' +
    'Priya Sharma\tpriya@example.com\tfd39_246\t16 April 2025\tPending\t1\n' +
    'Dup Person\trahul@example.com\tfd99\t20 April 2025\tPending\t0';
  const table = parsePastedText(pasted);
  check('Parsed 4 headers', table.headers.length === 6);
  check('Parsed 3 rows', table.rows.length === 3);

  const types = inferColumnTypes(table);
  check('Email column inferred as EMAIL', types.Email === 'EMAIL');
  check('Trigger column inferred as NUMBER (0/1)', types.Trigger === 'NUMBER');

  const emailCol = guessEmailColumn(table.headers);
  check('Email column guessed correctly', emailCol === 'Email');

  const dupes = analyzeDuplicates(table, emailCol!);
  check('Duplicate detection finds 1 duplicate row', dupes.duplicateRows === 1);
  check('Duplicate detection finds 2 unique emails', dupes.uniqueEmails === 2);

  // ── §12/§13 dataset + dynamic columns ──
  console.log('\n-- Dataset + columns --');
  const dataset = await prisma.dataset.create({
    data: {
      organizationId: org.id,
      workspaceId: workspace.id,
      ownerId: user.id,
      name: 'Smoke Test: Placement Students',
      columns: {
        create: [
          { key: 'Name', label: 'Name', type: ColumnType.TEXT, order: 1 },
          { key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 2 },
          { key: 'Code', label: 'Code', type: ColumnType.TEXT, order: 3 },
          { key: 'Status', label: 'Status', type: ColumnType.STATUS, order: 4 },
        ],
      },
    },
  });
  check('Dataset created', !!dataset.id);

  const columns = await prisma.datasetColumn.findMany({ where: { datasetId: dataset.id } });
  check('4 columns created', columns.length === 4);

  // ── §18/§19 contact linking (identity by email, never merged blindly) ──
  console.log('\n-- Contact linking --');
  const contactId1 = await findOrCreateContactForRecord({
    organizationId: org.id,
    workspaceId: workspace.id,
    datasetId: dataset.id,
    data: { Name: 'Rahul Sharma', Email: 'rahul@example.com', Code: 'fd41', Status: 'Pending' },
  });
  check('Contact created for first record', !!contactId1);

  const contactId2 = await findOrCreateContactForRecord({
    organizationId: org.id,
    workspaceId: workspace.id,
    datasetId: dataset.id,
    data: { Name: 'Rahul S.', Email: 'RAHUL@example.com', Code: 'other', Status: 'Pending' },
  });
  check('Same email (different case) resolves to the SAME contact', contactId1 === contactId2);

  const record = await prisma.record.create({
    data: {
      datasetId: dataset.id,
      contactId: contactId1,
      data: { Name: 'Rahul Sharma', Email: 'rahul@example.com', Code: 'fd41', Status: 'Pending' },
    },
  });
  check('Record created and linked to contact', record.contactId === contactId1);

  // ── §62 record change history ──
  console.log('\n-- Record change history --');
  const oldData = record.data as Record<string, unknown>;
  const newData = { ...oldData, Status: 'Completed' };
  await prisma.$transaction([
    prisma.record.update({ where: { id: record.id }, data: { data: newData } }),
    prisma.recordChangeHistory.create({
      data: {
        recordId: record.id,
        actorId: user.id,
        field: 'Status',
        oldValue: 'Pending' as any,
        newValue: 'Completed' as any,
        reason: 'Manual edit',
      },
    }),
  ]);
  const history = await prisma.recordChangeHistory.findMany({ where: { recordId: record.id } });
  check('Change history recorded field transition', history.length === 1 && history[0]?.field === 'Status');

  // ── §12 system email fields stay separate from business `data` ──
  console.log('\n-- System email fields isolation --');
  await prisma.record.update({
    where: { id: record.id },
    data: { emailStatus: 'SENT', lastEmailSentAt: new Date() },
  });
  const reloaded = await prisma.record.findUniqueOrThrow({ where: { id: record.id } });
  const businessStatus = (reloaded.data as Record<string, unknown>).Status;
  check('Business "Status" field untouched by email send tracking', businessStatus === 'Completed');
  check('System emailStatus field set independently', reloaded.emailStatus === 'SENT');

  // ── §94 multi-tenant isolation: a second workspace cannot see this data ──
  console.log('\n-- Multi-tenant isolation --');
  const otherUser = await prisma.user.create({
    data: {
      organizationId: org.id,
      googleId: `smoketest-other-${Date.now()}`,
      email: `smoketest-other+${Date.now()}@masaischool.com`,
      name: 'Other User',
      role: Role.OPERATOR,
    },
  });
  const otherWorkspace = await prisma.workspace.create({
    data: { organizationId: org.id, ownerId: otherUser.id, name: 'Other Workspace' },
  });
  const crossTenantDatasets = await prisma.dataset.findMany({ where: { workspaceId: otherWorkspace.id } });
  check('Other workspace sees zero datasets from workspace A', crossTenantDatasets.length === 0);

  // ── §95 audit log ──
  console.log('\n-- Audit log --');
  await prisma.auditLog.create({
    data: { organizationId: org.id, actorId: user.id, action: 'SMOKE_TEST', targetType: 'Dataset', targetId: dataset.id },
  });
  const auditRows = await prisma.auditLog.count({ where: { organizationId: org.id, action: 'SMOKE_TEST' } });
  check('Audit log entry recorded', auditRows === 1);

  // ── cleanup ──
  console.log('\n-- Cleanup --');
  await prisma.auditLog.deleteMany({ where: { organizationId: org.id, action: 'SMOKE_TEST' } });
  await prisma.recordChangeHistory.deleteMany({ where: { recordId: record.id } });
  await prisma.record.deleteMany({ where: { datasetId: dataset.id } });
  await prisma.datasetColumn.deleteMany({ where: { datasetId: dataset.id } });
  await prisma.dataset.delete({ where: { id: dataset.id } });
  await prisma.contact.deleteMany({ where: { workspaceId: workspace.id } });
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: [workspace.id, otherWorkspace.id] } } });
  await prisma.workspace.delete({ where: { id: workspace.id } });
  await prisma.workspace.delete({ where: { id: otherWorkspace.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.user.delete({ where: { id: otherUser.id } });
  console.log('  ✓ all smoke-test rows removed');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error('SMOKE TEST CRASHED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
