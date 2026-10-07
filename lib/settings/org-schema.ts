import { z } from 'zod';

/**
 * Organisation-level automation settings (pure: safe for client components).
 * Stored in IntegrationSettings.settings; every field has a default, so an
 * organisation that never opened the settings page gets sensible behaviour
 * and rows missing newer keys still parse.
 */

const emailList = z.array(z.string().trim().toLowerCase().email()).max(50);

export const INTENT_TAGS = {
  QUESTION: 'Question',
  REQUEST: 'Request',
  COMPLAINT: 'Complaint',
  NEEDS_ACTION: 'Needs action',
  COMPLETED: 'Completed',
  ACKNOWLEDGEMENT: 'Thanks',
} as const;

export type TriageIntent = keyof typeof INTENT_TAGS;
export const TRIAGE_INTENTS = Object.keys(INTENT_TAGS) as TriageIntent[];

export const orgSettingsSchema = z.object({
  /** Mailbox that sends digests and reports; null = the organisation's oldest connected Gmail. */
  senderAccountId: z.string().nullable().default(null),
  /** IST dates (YYYY-MM-DD) of the last scheduled sends, so a cron that fires twice sends once. */
  lastDigestOn: z.string().nullable().default(null),
  lastWeeklyReportOn: z.string().nullable().default(null),
  /**
   * Gmail mailboxes (EmailProviderAccount ids) whose owners allow them to be used as a
   * fallback sender on teammates' campaigns. Changed only by each owner, in Settings.
   */
  fallbackMailboxes: z.array(z.string()).max(500).default([]),
  digest: z
    .object({
      enabled: z.boolean().default(true),
      /** Email every SUPER_ADMIN and ADMIN in the organisation. */
      emailAdmins: z.boolean().default(true),
      extraEmails: emailList.default([]),
      slack: z.boolean().default(true),
      /** Hours before expiry that an unsigned document counts as "near expiry". */
      expiringWithinHours: z.number().int().min(1).max(24 * 14).default(48),
      /** A human reply with no answer for this long counts as unanswered. */
      unansweredAfterHours: z.number().int().min(1).max(24 * 14).default(24),
    })
    .default({}),
  weeklyReport: z
    .object({
      enabled: z.boolean().default(true),
      /** Email every SUPER_ADMIN. */
      emailSuperAdmins: z.boolean().default(true),
      extraEmails: emailList.default([]),
      slack: z.boolean().default(false),
    })
    .default({}),
  triage: z
    .object({
      enabled: z.boolean().default(true),
      autoTag: z.boolean().default(true),
      /** Unassigned conversations get this intent-based assignee; empty = conversation owner. */
      autoAssign: z.boolean().default(true),
      assignByIntent: z.record(z.string(), z.string()).default({}),
      autoResolveAcknowledgements: z.boolean().default(true),
      /** Minimum AI confidence (0–1) before a conversation is closed automatically. */
      autoResolveMinConfidence: z.number().min(0.5).max(1).default(0.85),
      draftReplies: z.boolean().default(true),
    })
    .default({}),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export function parseOrgSettings(raw: unknown): OrgSettings {
  const parsed = orgSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : orgSettingsSchema.parse({});
}
