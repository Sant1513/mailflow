import { Prisma, Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getOrgSettings } from '@/lib/settings/org';
import { emailsForRoles, postSystemSlack, sendSystemEmail, systemEmailShell } from '@/lib/notify/system';

/**
 * Daily housekeeping (/api/cron/housekeeping): keeps the database inside Supabase's free 500 MB
 * by deleting rows nobody reads after a while, and warns super admins before a free limit is near.
 *
 * Deleted (permanently; the laptop's nightly backups keep older copies):
 * - in-app notifications older than 90 days,
 * - audit log entries older than 365 days, or longer when the organisation's retention policy
 *   (Super Admin → System Settings → Data retention) asks to keep them longer,
 * - finished webhook deliveries older than 30 days,
 * - expired sign-in sessions and verification tokens.
 * Never touched: emails, conversations, History (promised immutable), contacts, documents.
 *
 * Deletes go in batches of 5,000 within a time budget, so a big first run finishes over a few days.
 */
export const KEEP_DAYS = { notifications: 90, auditLog: 365, webhookDeliveries: 30 } as const;
const BATCH = 5_000;
/** Warn super admins (once a day) above these sizes; the free limits are 500 MB and 1 GB. */
export const WARN_BYTES = { database: 350 * 1024 * 1024, storage: 700 * 1024 * 1024 } as const;

export interface HousekeepingResult {
  deleted: { notifications: number; auditLogs: number; webhookDeliveries: number; sessions: number; verificationTokens: number };
  outOfTime: boolean;
  usage: { databaseBytes: number | null; storageBytes: number | null };
  warnings: string[];
  alerts: string[];
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

/** Runs one batched DELETE until fewer than BATCH rows go or the budget is spent. */
async function deleteInBatches(run: () => Promise<number>, outOfTime: () => boolean): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await run();
    total += n;
    if (n < BATCH || outOfTime()) return total;
  }
}

/** Audit log days for an organisation: 365, or the retention policy's number when it is longer. */
export function auditKeepDays(policyDays: number | null | undefined): number {
  return Math.max(KEEP_DAYS.auditLog, policyDays ?? 0);
}

export async function runDailyHousekeeping(opts: { now?: Date; budgetMs?: number } = {}): Promise<HousekeepingResult> {
  const now = opts.now ?? new Date();
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? 25_000;
  const outOfTime = () => Date.now() - startedAt > budgetMs;
  const result: HousekeepingResult = {
    deleted: { notifications: 0, auditLogs: 0, webhookDeliveries: 0, sessions: 0, verificationTokens: 0 },
    outOfTime: false,
    usage: { databaseBytes: null, storageBytes: null },
    warnings: [],
    alerts: [],
  };

  const notifCutoff = daysAgo(now, KEEP_DAYS.notifications);
  result.deleted.notifications = await deleteInBatches(
    () => prisma.$executeRaw`DELETE FROM "Notification" WHERE "id" IN (SELECT "id" FROM "Notification" WHERE "createdAt" < ${notifCutoff} LIMIT ${BATCH})`,
    outOfTime,
  );

  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const policies = await prisma.retentionPolicy.findMany({ select: { organizationId: true, auditLogDays: true } });
  for (const org of orgs) {
    if (outOfTime()) break;
    const cutoff = daysAgo(now, auditKeepDays(policies.find((p) => p.organizationId === org.id)?.auditLogDays));
    result.deleted.auditLogs += await deleteInBatches(
      () => prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "id" IN (SELECT "id" FROM "AuditLog" WHERE "organizationId" = ${org.id} AND "createdAt" < ${cutoff} LIMIT ${BATCH})`,
      outOfTime,
    );
  }

  if (!outOfTime()) {
    const hookCutoff = daysAgo(now, KEEP_DAYS.webhookDeliveries);
    result.deleted.webhookDeliveries = await deleteInBatches(
      () => prisma.$executeRaw`DELETE FROM "WebhookDelivery" WHERE "id" IN (SELECT "id" FROM "WebhookDelivery" WHERE "createdAt" < ${hookCutoff} AND "status" <> 'PENDING' LIMIT ${BATCH})`,
      outOfTime,
    );
  }
  if (!outOfTime()) {
    result.deleted.sessions = await deleteInBatches(
      () => prisma.$executeRaw`DELETE FROM "Session" WHERE "id" IN (SELECT "id" FROM "Session" WHERE "expires" < ${now} LIMIT ${BATCH})`,
      outOfTime,
    );
    result.deleted.verificationTokens = await prisma.verificationToken.deleteMany({ where: { expires: { lt: now } } }).then((r) => r.count);
  }
  result.outOfTime = outOfTime();

  // Free-tier early warning.
  result.usage = await measureUsage();
  const db = result.usage.databaseBytes;
  const storage = result.usage.storageBytes;
  if (db !== null && db > WARN_BYTES.database) result.warnings.push(`Database is ${mb(db)} of the free 500 MB`);
  if (storage !== null && storage > WARN_BYTES.storage) result.warnings.push(`File storage is ${mb(storage)} of the free 1 GB`);
  if (result.warnings.length) {
    const day = now.toISOString().slice(0, 10);
    for (const org of orgs) {
      if (!(await claimUsageAlert(org.id, day))) continue;
      result.alerts.push(...(await sendUsageAlert(org.id, result.warnings)));
    }
  }
  console.log('[housekeeping]', JSON.stringify({ deleted: result.deleted, outOfTime: result.outOfTime, usage: result.usage, warnings: result.warnings }));
  return result;
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Database size, and Supabase Storage's total (no storage schema locally: null). */
export async function measureUsage(): Promise<HousekeepingResult['usage']> {
  const usage: HousekeepingResult['usage'] = { databaseBytes: null, storageBytes: null };
  try {
    const rows = await prisma.$queryRaw<{ bytes: bigint | number }[]>`SELECT pg_database_size(current_database()) AS bytes`;
    usage.databaseBytes = Number(rows[0]?.bytes ?? 0);
  } catch (err) {
    console.error('[housekeeping] database size', err);
  }
  try {
    const rows = await prisma.$queryRaw<{ bytes: bigint | number | null }[]>`SELECT COALESCE(sum(COALESCE(("metadata"->>'size')::bigint, 0)), 0) AS bytes FROM storage.objects`;
    usage.storageBytes = Number(rows[0]?.bytes ?? 0);
  } catch {
    // No Supabase Storage schema (laptop database): nothing to measure.
  }
  return usage;
}

/** Once a day per organisation (atomic, like the daily report's marker). */
async function claimUsageAlert(organizationId: string, day: string): Promise<boolean> {
  await prisma.integrationSettings.upsert({ where: { organizationId }, update: {}, create: { organizationId, settings: {} } });
  const n = await prisma.$executeRaw`
    UPDATE "IntegrationSettings"
    SET "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), ${Prisma.raw(`'{lastUsageAlertOn}'`)}, to_jsonb(${day}::text)), "updatedAt" = now()
    WHERE "organizationId" = ${organizationId} AND COALESCE("settings"->>'lastUsageAlertOn', '') <> ${day}`;
  return n > 0;
}

async function sendUsageAlert(organizationId: string, warnings: string[]): Promise<string[]> {
  const text = `MailFlow is close to a free-plan limit: ${warnings.join('; ')}. Old rows are cleaned up daily; if it keeps growing, ask for a cleanup of old email bodies.`;
  const settings = await getOrgSettings(organizationId).catch(() => null);
  const [slack, email] = await Promise.all([
    postSystemSlack(organizationId, `:warning: ${text}`),
    sendSystemEmail({
      organizationId,
      senderAccountId: settings?.senderAccountId ?? null,
      to: await emailsForRoles(organizationId, [Role.SUPER_ADMIN]),
      subject: 'MailFlow is close to a free-plan limit',
      html: systemEmailShell('Close to a free-plan limit', 'MailFlow runs on free plans. This is an early warning, before anything stops working.', `<ul>${warnings.map((w) => `<li>${w}</li>`).join('')}</ul>`),
    }),
  ]);
  return [`slack: ${slack}`, `email: ${email}`];
}
