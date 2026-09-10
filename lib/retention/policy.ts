import { z } from 'zod';

/**
 * §130 retention policy — configuration and impact preview only.
 *
 * Deliberately NOT wired to any deletion job. The spec says "do not delete
 * historical communication accidentally" and "allow FUTURE admin-controlled
 * retention", so this phase records the policy, shows exactly how many rows
 * it would touch, and audits every change. Enforcement, when it lands, will
 * be an explicit, separately audited action that reads this policy — never
 * a background sweep that runs because a number was typed into a box.
 */

/** Never below 30 days: a shorter window would erase threads still in use. */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

const daysField = z
  .number()
  .int()
  .min(MIN_RETENTION_DAYS, `Minimum ${MIN_RETENTION_DAYS} days`)
  .max(MAX_RETENTION_DAYS, `Maximum ${MAX_RETENTION_DAYS} days`)
  .nullable();

export const retentionPolicySchema = z.object({
  messageBodyDays: daysField,
  emailJobBodyDays: daysField,
  auditLogDays: daysField,
});

export type RetentionPolicyInput = z.infer<typeof retentionPolicySchema>;

export const EMPTY_POLICY: RetentionPolicyInput = {
  messageBodyDays: null,
  emailJobBodyDays: null,
  auditLogDays: null,
};

/** The instant before which rows fall under a `days` rule; null = keep forever. */
export function cutoffFor(days: number | null | undefined, now = new Date()): Date | null {
  if (days === null || days === undefined) return null;
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS) {
    throw new Error(`Retention days must be an integer >= ${MIN_RETENTION_DAYS}`);
  }
  return new Date(now.getTime() - days * 86_400_000);
}

export interface RetentionPreview {
  /** ConversationMessages whose bodies would be stripped. */
  messageBodies: number;
  /** Sent EmailJobs whose html/plainText snapshot would be stripped. */
  emailJobBodies: number;
  /** AuditLog rows that would be deleted. */
  auditLogs: number;
}

/** Diff for the audit trail: which fields changed and from/to what. */
export function policyDiff(before: RetentionPolicyInput, after: RetentionPolicyInput) {
  const out: Record<string, { from: number | null; to: number | null }> = {};
  for (const key of Object.keys(retentionPolicySchema.shape) as (keyof RetentionPolicyInput)[]) {
    if (before[key] !== after[key]) out[key] = { from: before[key], to: after[key] };
  }
  return out;
}
