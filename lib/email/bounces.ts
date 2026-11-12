import { prisma } from '@/lib/db/client';
import { dispatchWebhook } from '@/lib/webhooks/dispatch';
import { parseDeliveryReport, suppressionRule, type BounceCategory } from '@/lib/email/dsn';

/**
 * Bounce notices. With Gmail most bounces don't fail the send: Gmail accepts the message and a
 * "Delivery Status Notification" arrives in the same thread minutes later (or an Office 365
 * "Undeliverable" in a thread of its own). Those notices are read by lib/email/dsn.ts and acted
 * on by lib/email/ndr.ts so the dead address is suppressed and never mailed again (protecting the
 * sender reputation Google judges every mailbox by). This file holds the suppression writes.
 */

export interface BounceInfo {
  /** Addresses the notice says could not be delivered to (lower-cased). */
  recipients: string[];
  /** True when the notice suppresses at once (a hard bounce, a policy or spam block). */
  permanent: boolean;
  /** Short human-readable reason, for the suppression list. */
  detail: string;
  /** The first failure's category and status code. */
  category?: BounceCategory;
  statusCode?: string | null;
}

/**
 * Reads a bounce notice (summary form, kept for older callers and scripts; lib/email/dsn.ts has
 * the per-recipient detail). `ownAddresses` (our mailboxes) are never treated as the failed recipient.
 */
export function parseBounce(
  message: { plainTextBody: string | null; htmlBody: string | null; headers?: Record<string, string>; subject?: string },
  ownAddresses: string[] = [],
): BounceInfo {
  // Read as a delivery report even without the usual headers (stored notices lost them).
  const report = parseDeliveryReport(message, ownAddresses, { assumeReport: true });
  const failures = report?.failures ?? [];
  const first = failures[0];
  return {
    recipients: failures.map((f) => f.email).filter((e): e is string => !!e),
    permanent: failures.some((f) => suppressionRule(f.category) === 'NOW'),
    detail: (first?.diagnostic ?? first?.remark ?? 'Delivery failed').replace(/\s+/g, ' ').trim().slice(0, 300),
    category: first?.category,
    statusCode: first?.statusCode ?? null,
  };
}

/**
 * Every workspace in the organisation gets every bounce and spam complaint already known, so a
 * workspace created after a bounce (a new teammate) never emails that address. recordHardBounce
 * spreads each new bounce at the time; this fills the gaps (on sign-up and once a day). Every
 * bounce category spreads (an address that doesn't exist, has left, or blocks us blocks everyone).
 * Unsubscribes stay per workspace: they're a choice about that sender. Returns rows added.
 */
export async function syncOrgBounces(organizationId: string): Promise<number> {
  return prisma.$executeRaw`
    INSERT INTO "EmailSuppression" (id, "workspaceId", email, reason, source, detail, category, "statusCode", remark, "createdAt")
    SELECT 'sb' || substr(md5(w.id || ':' || b.email || ':' || clock_timestamp()::text), 1, 23), w.id, b.email, b.reason, 'BOUNCE',
           left(COALESCE(b.detail, b.reason) || ' (known across the organisation)', 1000), b.category, b."statusCode", b.remark, now()
    FROM "Workspace" w
    JOIN (
      SELECT DISTINCT ON (s.email, s.reason) s.email, s.reason, s.detail, s.category, s."statusCode", s.remark
      FROM "EmailSuppression" s JOIN "Workspace" ws ON ws.id = s."workspaceId"
      WHERE ws."organizationId" = ${organizationId} AND s.reason IN ('BOUNCED', 'COMPLAINT')
      ORDER BY s.email, s.reason, s."createdAt"
    ) b ON TRUE
    WHERE w."organizationId" = ${organizationId}
    ON CONFLICT ("workspaceId", email) DO NOTHING`;
}

/**
 * A permanent bounce (or a spam complaint / left-the-company reply), from any tool (campaign,
 * Quick Send, Recruiter Bulk Send) and any user: suppressed in EVERY workspace of the
 * organization, not just the sender's — no teammate's tool should mail it again. The sender's
 * entry carries the full reason and the send; the others say it bounced on a teammate's send.
 * Existing entries (an unsubscribe, a manual entry, an earlier bounce) are kept as they are.
 * Also marks matching records BOUNCED with the error, and fires the email.bounced webhook.
 */
export async function recordHardBounce(input: {
  workspaceId: string;
  email: string;
  detail: string;
  campaignId?: string | null;
  webhook?: boolean;
  category?: BounceCategory | null;
  statusCode?: string | null;
  remark?: string | null;
  recruiterBlastId?: string | null;
  /** COMPLAINT for a spam complaint; everything else is BOUNCED. */
  reason?: 'BOUNCED' | 'COMPLAINT';
}): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const detail = input.detail.slice(0, 1000);
  const reason = input.reason ?? 'BOUNCED';
  const source = reason === 'COMPLAINT' ? 'COMPLAINT' : 'BOUNCE';
  const extra = {
    ...(input.category ? { category: input.category } : {}),
    ...(input.statusCode ? { statusCode: input.statusCode.slice(0, 40) } : {}),
    ...(input.remark ? { remark: input.remark.slice(0, 300) } : {}),
  };
  const ws = await prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { organizationId: true } });
  await prisma.emailSuppression.upsert({
    where: { workspaceId_email: { workspaceId: input.workspaceId, email } },
    create: {
      workspaceId: input.workspaceId,
      email,
      source,
      reason,
      detail,
      campaignId: input.campaignId ?? undefined,
      ...(input.recruiterBlastId ? { recruiterBlastId: input.recruiterBlastId } : {}),
      ...extra,
    },
    update: {},
  });
  if (ws) {
    const others = await prisma.workspace.findMany({ where: { organizationId: ws.organizationId, id: { not: input.workspaceId } }, select: { id: true } });
    if (others.length) {
      await prisma.emailSuppression.createMany({
        data: others.map((o) => ({ workspaceId: o.id, email, source, reason, detail: `${detail} (bounced on a teammate's send)`.slice(0, 1000), ...extra })),
        skipDuplicates: true,
      });
    }
  }
  await prisma.record.updateMany({
    where: { contact: { primaryEmail: { equals: email, mode: 'insensitive' }, ...(ws ? { workspace: { organizationId: ws.organizationId } } : { workspaceId: input.workspaceId }) } },
    data: { emailStatus: 'BOUNCED', lastEmailError: detail.slice(0, 500) },
  });
  if (input.webhook !== false) {
    dispatchWebhook(input.workspaceId, 'email.bounced', { email, reason, detail, category: input.category ?? null, statusCode: input.statusCode ?? null, campaignId: input.campaignId ?? null }).catch(() => undefined);
  }
}

/**
 * Suppresses the addresses a hard bounce names (summary form, used by older scripts; live mail
 * goes through lib/email/ndr.ts, which also handles full mailboxes and marks the sends). When
 * the notice doesn't say which address failed, the conversation's own recipient is used.
 * Returns the suppressed addresses.
 */
export async function suppressBounced(input: {
  workspaceId: string;
  conversationRecipient: string | null;
  message: { plainTextBody: string | null; htmlBody: string | null; headers?: Record<string, string>; subject?: string };
  ownAddresses: string[];
  /** Where it came from, for the suppression list's detail (default "Bounce notice"). */
  label?: string;
}): Promise<string[]> {
  const report = parseDeliveryReport(input.message, input.ownAddresses, { assumeReport: true });
  const own = new Set(input.ownAddresses.map((a) => a.toLowerCase()));
  const fallback = input.conversationRecipient?.toLowerCase();
  const usableFallback = fallback && !own.has(fallback) && !/^(mailer-daemon|postmaster|mail-daemon)@/i.test(fallback) ? fallback : null;
  const done: string[] = [];
  for (const f of report?.failures ?? []) {
    if (suppressionRule(f.category) !== 'NOW') continue;
    const email = f.email ?? usableFallback;
    if (!email || done.includes(email)) continue;
    const lastJob = await prisma.emailJob.findFirst({
      where: { toEmail: { equals: email, mode: 'insensitive' }, campaign: { workspaceId: input.workspaceId } },
      orderBy: { createdAt: 'desc' },
      select: { campaignId: true },
    });
    const detail = `${input.label ?? 'Bounce notice'}: ${f.diagnostic ?? f.remark}`;
    await recordHardBounce({ workspaceId: input.workspaceId, email, detail, campaignId: lastJob?.campaignId ?? null, category: f.category, statusCode: f.statusCode, remark: f.remark });
    done.push(email);
  }
  return done;
}
