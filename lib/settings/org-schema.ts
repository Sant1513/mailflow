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
  INTERESTED: 'Interested',
  NOT_INTERESTED: 'Not interested',
} as const;

export type TriageIntent = keyof typeof INTENT_TAGS;
export const TRIAGE_INTENTS = Object.keys(INTENT_TAGS) as TriageIntent[];

/** Recruiter Bulk Send repeat window (mirrors lib/recruiterSend/recent.ts, which is server-only). */
export const RECRUITER_REPEAT_DEFAULT_DAYS = 10;
export const RECRUITER_REPEAT_MAX_DAYS = 90;
export const RECRUITER_REPEAT_SHORT_DAYS = 7;

export const orgSettingsSchema = z.object({
  /** Mailbox that sends digests and reports; null = the organisation's oldest connected Gmail. */
  senderAccountId: z.string().nullable().default(null),
  /** IST dates (YYYY-MM-DD) of the last scheduled sends, so a cron that fires twice sends once. */
  lastDigestOn: z.string().nullable().default(null),
  /** The report day (YYYY-MM-DD, IST) of the last 8 PM daily report sent. */
  lastDailyReportOn: z.string().nullable().default(null),
  lastWeeklyReportOn: z.string().nullable().default(null),
  /** Day (YYYY-MM-DD, UTC) the free-plan usage warning last went out (lib/retention/housekeeping.ts). */
  lastUsageAlertOn: z.string().nullable().default(null),
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
      /**
       * The daily report as one visible email: To these addresses, CC the next list, no Bcc.
       * Empty = the older way (every admin + extraEmails, hidden in Bcc).
       */
      to: emailList.default([]),
      cc: emailList.default([]),
      slack: z.boolean().default(true),
      /** Slack channel for the report (ID, e.g. C09FEU43FK8); empty = the notifications channel. */
      slackChannel: z.string().trim().regex(/^$|^[CGD][A-Z0-9]{6,20}$/, 'A Slack channel ID looks like C09FEU43FK8').default(''),
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
      /** Slack channel for the weekly report; empty = the notifications channel. */
      slackChannel: z.string().trim().regex(/^$|^[CGD][A-Z0-9]{6,20}$/, 'A Slack channel ID looks like C09FEU43FK8').default(''),
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
  /**
   * How approval requests and decisions reach people. They always show in the app (bell and Approvals badge).
   *   DIGEST  one summary email per interval listing what is waiting (the default: no flood)
   *   IN_APP  nothing by email
   *   EMAIL   one email per request and per decision (the old way)
   */
  approvals: z
    .object({
      notify: z.enum(['EMAIL', 'DIGEST', 'IN_APP']).default('DIGEST'),
      /** Shortest gap between two summary emails. */
      digestMinutes: z.number().int().min(15).max(1440).default(60),
      /** Markers of the last summary email (internal): when, and which campaigns it listed. */
      lastDigestAt: z.string().nullable().default(null),
      lastDigestIds: z.array(z.string()).max(300).default([]),
    })
    .default({}),
  recruiter: z
    .object({
      /** New recruiter sends skip anyone emailed from MailFlow in the last N days (0 = off). */
      repeatWindowDays: z.number().int().min(0).max(RECRUITER_REPEAT_MAX_DAYS).default(RECRUITER_REPEAT_DEFAULT_DAYS),
    })
    .default({}),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export function parseOrgSettings(raw: unknown): OrgSettings {
  const parsed = orgSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : orgSettingsSchema.parse({});
}
