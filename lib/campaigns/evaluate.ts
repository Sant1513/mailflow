import { validateVariables, renderTemplate } from '@/lib/templates/variables';

/**
 * §34 Dry run and §91 "why sent / why skipped".
 *
 * This module is pure: given records + template + already-sent history, it
 * decides what would happen, with a human-readable reason for every single
 * record. The dry run and the real send share this code, which is the only
 * way "Run Simulation" can be trusted to predict the real thing.
 */

export const SKIP_REASONS = {
  ALREADY_SENT: 'ALREADY_SENT',
  INVALID_EMAIL: 'INVALID_EMAIL',
  MISSING_EMAIL: 'MISSING_EMAIL',
  MISSING_VARIABLE: 'MISSING_VARIABLE',
  DUPLICATE_IN_BATCH: 'DUPLICATE_IN_BATCH',
  CONDITION_NOT_MET: 'CONDITION_NOT_MET',
  FREQUENCY_LIMIT: 'FREQUENCY_LIMIT',
  MANUALLY_SKIPPED: 'MANUALLY_SKIPPED',
} as const;

export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];

export interface EvaluableRecord {
  id: string;
  data: Record<string, unknown>;
}

export interface EvaluationContext {
  emailColumnKey: string;
  template: { subject: string; html: string; plainText?: string | null };
  /** Record ids already sent for this (campaign, templateVersion) — §41. */
  alreadySentRecordIds?: Set<string>;
  /** Record ids the user explicitly excluded. */
  manuallySkippedRecordIds?: Set<string>;
  /**
   * Records whose automation condition evaluated false, with the condition
   * text so the UI can explain exactly why (§35).
   */
  conditionResults?: Map<string, { met: boolean; description: string }>;
  /** Record ids blocked by a send-frequency policy (§37). */
  frequencyBlockedRecordIds?: Map<string, string>;
  /** Human-readable origin, used to build sendReason (§35). */
  origin?: {
    campaignName?: string;
    automationName?: string;
    templateName?: string;
    templateVersion?: number;
    batchLabel?: string;
    senderEmail?: string;
  };
}

export interface RecordEvaluation {
  recordId: string;
  willSend: boolean;
  email: string | null;
  skipReason: SkipReason | null;
  /** Human-readable, shown verbatim in the UI (§34 "exact reason"). */
  reasonDetail: string;
  /** §35 "Why was this email sent?" — only set when willSend. */
  sendReason: string | null;
  missingVariables: string[];
}

export interface DryRunSummary {
  total: number;
  wouldSend: number;
  skipped: number;
  invalid: number;
  byReason: Record<string, number>;
  evaluations: RecordEvaluation[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildSendReason(record: EvaluableRecord, ctx: EvaluationContext): string {
  const o = ctx.origin ?? {};
  const lines: string[] = [];
  if (o.campaignName) lines.push(`Campaign: ${o.campaignName}`);
  if (o.automationName) lines.push(`Automation: ${o.automationName}`);
  const condition = ctx.conditionResults?.get(record.id);
  if (condition) lines.push(`Condition: ${condition.description} ✓`);
  if (o.templateName) {
    lines.push(`Template: ${o.templateName}${o.templateVersion ? ` v${o.templateVersion}` : ''}`);
  }
  if (o.batchLabel) lines.push(`Batch: ${o.batchLabel}`);
  if (o.senderEmail) lines.push(`Sender: ${o.senderEmail}`);

  // §35 makes the origin explanation mandatory, so never return an empty
  // string: a stored blank would make "why was this sent?" unanswerable
  // later, which is exactly what that rule exists to prevent.
  if (lines.length === 0) {
    return `Record ${record.id} passed all send checks (no campaign/automation origin was recorded).`;
  }
  return lines.join('\n');
}

/** Evaluates one record. Order of checks determines which reason wins. */
export function evaluateRecord(
  record: EvaluableRecord,
  ctx: EvaluationContext,
  seenEmails: Set<string>
): RecordEvaluation {
  const rawEmail = record.data[ctx.emailColumnKey];
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';

  const base = {
    recordId: record.id,
    email: email || null,
    sendReason: null,
    missingVariables: [] as string[],
  };

  // Explicit user exclusion beats everything else.
  if (ctx.manuallySkippedRecordIds?.has(record.id)) {
    return { ...base, willSend: false, skipReason: SKIP_REASONS.MANUALLY_SKIPPED, reasonDetail: 'Excluded by the user.' };
  }

  // Automation conditions (§71) — checked before validity so the UI reports
  // "condition not met" rather than complaining about a missing email on a
  // record that was never going to be contacted.
  const condition = ctx.conditionResults?.get(record.id);
  if (condition && !condition.met) {
    return {
      ...base,
      willSend: false,
      skipReason: SKIP_REASONS.CONDITION_NOT_MET,
      reasonDetail: `Automation condition not met: ${condition.description}`,
    };
  }

  // §41 duplicate protection.
  if (ctx.alreadySentRecordIds?.has(record.id)) {
    return {
      ...base,
      willSend: false,
      skipReason: SKIP_REASONS.ALREADY_SENT,
      reasonDetail: 'Already sent to this record for this campaign and template version.',
    };
  }

  // §37 send-frequency protection.
  const frequencyBlock = ctx.frequencyBlockedRecordIds?.get(record.id);
  if (frequencyBlock) {
    return { ...base, willSend: false, skipReason: SKIP_REASONS.FREQUENCY_LIMIT, reasonDetail: frequencyBlock };
  }

  if (!email) {
    return { ...base, willSend: false, skipReason: SKIP_REASONS.MISSING_EMAIL, reasonDetail: 'No email address on this record.' };
  }
  if (!EMAIL_RE.test(email)) {
    return { ...base, willSend: false, skipReason: SKIP_REASONS.INVALID_EMAIL, reasonDetail: `"${email}" is not a valid email address.` };
  }

  // Same address twice in one batch — send once, skip the rest.
  const normalized = email.toLowerCase();
  if (seenEmails.has(normalized)) {
    return {
      ...base,
      willSend: false,
      skipReason: SKIP_REASONS.DUPLICATE_IN_BATCH,
      reasonDetail: `${email} already appears earlier in this campaign.`,
    };
  }

  // §24: a variable with no value blocks the send rather than mailing a
  // student "Dear ,".
  const rendered = renderTemplate(ctx.template, record.data);
  if (rendered.missingVariables.length > 0) {
    return {
      ...base,
      willSend: false,
      skipReason: SKIP_REASONS.MISSING_VARIABLE,
      reasonDetail: `Missing value for ${rendered.missingVariables.map((v) => `{{${v}}}`).join(', ')}.`,
      missingVariables: rendered.missingVariables,
    };
  }

  seenEmails.add(normalized);
  return {
    ...base,
    willSend: true,
    skipReason: null,
    reasonDetail: 'Ready to send.',
    sendReason: buildSendReason(record, ctx),
  };
}

export function dryRun(records: EvaluableRecord[], ctx: EvaluationContext): DryRunSummary {
  const seenEmails = new Set<string>();
  const evaluations = records.map((record) => evaluateRecord(record, ctx, seenEmails));

  const byReason: Record<string, number> = {};
  for (const evaluation of evaluations) {
    if (evaluation.skipReason) {
      byReason[evaluation.skipReason] = (byReason[evaluation.skipReason] ?? 0) + 1;
    }
  }

  const wouldSend = evaluations.filter((e) => e.willSend).length;
  const invalid =
    (byReason[SKIP_REASONS.INVALID_EMAIL] ?? 0) +
    (byReason[SKIP_REASONS.MISSING_EMAIL] ?? 0) +
    (byReason[SKIP_REASONS.MISSING_VARIABLE] ?? 0);

  return {
    total: records.length,
    wouldSend,
    skipped: records.length - wouldSend,
    invalid,
    byReason,
    evaluations,
  };
}

/** §33 pre-send validation — campaign-level checks, distinct from per-record. */
export interface CampaignValidationIssue {
  id: string;
  level: 'error' | 'warning';
  message: string;
}

export function validateCampaign(input: {
  hasDataset: boolean;
  hasTemplate: boolean;
  hasEmailColumn: boolean;
  senderConnected: boolean;
  senderStatus?: string | null;
  template?: { subject: string; html: string; plainText?: string | null };
  availableColumnKeys?: string[];
  recipientCount: number;
  canSend: boolean;
}): { issues: CampaignValidationIssue[]; blocked: boolean } {
  const issues: CampaignValidationIssue[] = [];
  const error = (id: string, message: string) => issues.push({ id, level: 'error', message });
  const warn = (id: string, message: string) => issues.push({ id, level: 'warning', message });

  if (!input.hasDataset) error('dataset', 'No dataset selected.');
  if (!input.hasTemplate) error('template', 'No template selected.');
  if (!input.hasEmailColumn) error('recipient', 'The dataset has no email column to send to.');
  if (!input.senderConnected) {
    error('sender', 'No Gmail account connected. Connect one in Settings before sending.');
  } else if (input.senderStatus && input.senderStatus !== 'CONNECTED') {
    error('sender', `The connected Gmail account needs attention (status: ${input.senderStatus}). Reconnect it in Settings.`);
  }
  if (!input.canSend) error('permission', 'You do not have permission to send campaigns.');

  if (input.template && input.availableColumnKeys) {
    const validation = validateVariables(input.template, input.availableColumnKeys);
    if (!validation.ok) {
      error('variables', `Template uses ${validation.missing.map((v) => `{{${v}}}`).join(', ')}, which the dataset does not provide.`);
    }
  }

  if (input.recipientCount === 0) error('recipients', 'No recipients would receive this campaign.');
  else if (input.recipientCount > 500) {
    warn('volume', `${input.recipientCount} recipients — this will take a while at the configured send rate.`);
  }

  return { issues, blocked: issues.some((i) => i.level === 'error') };
}
