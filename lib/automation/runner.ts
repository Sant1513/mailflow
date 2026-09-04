import { prisma } from '@/lib/db/client';
import { evaluateCondition, describeCondition, type Condition } from './conditions';
import { checkFrequency, checkStopConditions, type FrequencyPolicy } from './frequency';
import { renderTemplate } from '@/lib/templates/variables';
import { EmailJobStatus, BatchStatus, CampaignStatus, EmailProvider as EmailProviderEnum } from '@prisma/client';

/**
 * §68-74 automation engine.
 *
 * Evaluation order matters and is deliberate:
 *   1. automation enabled?      — a disabled automation never acts
 *   2. stop conditions          — §71, checked BEFORE the trigger conditions
 *                                 so "student already replied" wins
 *   3. trigger conditions       — §69
 *   4. send-frequency policy    — §37
 *   5. action                   — §70
 *
 * Every path writes an AutomationRun row (§72), including the ones that do
 * nothing, so "why didn't this fire?" is always answerable.
 */

export interface AutomationActionConfig {
  type: 'SEND_EMAIL' | 'UPDATE_RECORD' | 'WAIT' | 'NOTIFY_USER';
  config: Record<string, unknown>;
}

export interface EvaluateResult {
  result: 'TRIGGERED' | 'SKIPPED' | 'ERROR';
  conditionsMet: boolean;
  actionTaken: string | null;
  reason: string;
  runId?: string;
}

interface AutomationVersionShape {
  id: string;
  automationId: string;
  version: number;
  triggerType: string;
  conditions: unknown;
  actions: unknown;
  stopConditions: unknown;
  frequencyPolicy: unknown;
}

function asCondition(value: unknown): Condition | null {
  if (!value || typeof value !== 'object') return null;
  return value as Condition;
}

function asPolicy(value: unknown): FrequencyPolicy {
  if (value && typeof value === 'object' && 'mode' in (value as any)) return value as FrequencyPolicy;
  // Absent policy defaults to the safest useful behaviour, not "send freely".
  return { mode: 'ONCE' };
}

function asActions(value: unknown): AutomationActionConfig[] {
  return Array.isArray(value) ? (value as AutomationActionConfig[]) : [];
}

/**
 * Counts how many records an automation version would act on right now.
 * Used by §74's "Automation Ready — potential records: N" confirmation, so
 * mass email is never silently switched on.
 */
export async function previewImpact(
  version: AutomationVersionShape,
  datasetId: string | null
): Promise<{ potentialRecords: number; totalRecords: number; conditionText: string }> {
  const conditions = asCondition(version.conditions) ?? { op: 'AND', rules: [] };
  const conditionText = describeCondition(conditions);

  if (!datasetId) return { potentialRecords: 0, totalRecords: 0, conditionText };

  const records = await prisma.record.findMany({ where: { datasetId }, select: { id: true, data: true } });
  const stopConditions = asCondition(version.stopConditions);

  let matching = 0;
  for (const record of records) {
    const data = (record.data ?? {}) as Record<string, unknown>;
    if (stopConditions && checkStopConditions(stopConditions, data).stopped) continue;
    if (evaluateCondition(conditions, data)) matching += 1;
  }

  return { potentialRecords: matching, totalRecords: records.length, conditionText };
}

/**
 * Evaluates one automation against one record and, if everything passes,
 * performs the configured action.
 */
export async function evaluateAutomationForRecord(opts: {
  automationId: string;
  recordId: string;
  triggerType: string;
  /** Set false during previews so nothing is actually sent. */
  performActions?: boolean;
}): Promise<EvaluateResult> {
  const { automationId, recordId, triggerType, performActions = true } = opts;

  const automation = await prisma.automation.findUnique({
    where: { id: automationId },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  const version = automation?.versions[0];

  if (!automation || !version) {
    return { result: 'ERROR', conditionsMet: false, actionTaken: null, reason: 'Automation or version not found.' };
  }

  const record = await prisma.record.findUnique({
    where: { id: recordId },
    include: { dataset: true, contact: true },
  });
  if (!record) {
    return { result: 'ERROR', conditionsMet: false, actionTaken: null, reason: 'Record not found.' };
  }

  const log = async (result: EvaluateResult): Promise<EvaluateResult> => {
    const run = await prisma.automationRun.create({
      data: {
        automationId: automation.id,
        automationVersionId: version.id,
        recordId,
        triggerType,
        conditionsMet: result.conditionsMet,
        actionTaken: result.actionTaken,
        result: result.result,
        error: result.result === 'ERROR' ? result.reason : null,
      },
    });
    return { ...result, runId: run.id };
  };

  if (!automation.enabled) {
    return log({ result: 'SKIPPED', conditionsMet: false, actionTaken: null, reason: 'Automation is disabled.' });
  }

  const data = (record.data ?? {}) as Record<string, unknown>;

  // §71: stop conditions are checked first, so an automation cannot chase a
  // student who has already replied or completed.
  const stop = checkStopConditions(asCondition(version.stopConditions), data);
  if (stop.stopped) {
    return log({ result: 'SKIPPED', conditionsMet: false, actionTaken: null, reason: stop.reason });
  }

  const conditions = asCondition(version.conditions) ?? { op: 'AND', rules: [] };
  const conditionsMet = evaluateCondition(conditions, data);
  if (!conditionsMet) {
    return log({
      result: 'SKIPPED',
      conditionsMet: false,
      actionTaken: null,
      reason: `Conditions not met: ${describeCondition(conditions)}`,
    });
  }

  // §37: has this record been emailed by this automation too recently?
  const priorSends = await prisma.emailJob.findMany({
    where: {
      recordId,
      status: EmailJobStatus.SENT,
      campaign: { automationId: automation.id },
    },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true, campaignId: true },
  });

  const frequency = checkFrequency(
    asPolicy(version.frequencyPolicy),
    priorSends.filter((s) => s.sentAt).map((s) => ({ sentAt: s.sentAt!, campaignId: s.campaignId })),
    {}
  );
  if (!frequency.allowed) {
    return log({ result: 'SKIPPED', conditionsMet: true, actionTaken: null, reason: frequency.reason });
  }

  if (!performActions) {
    return log({
      result: 'SKIPPED',
      conditionsMet: true,
      actionTaken: null,
      reason: 'Preview only — no action performed.',
    });
  }

  // ── Perform actions (§70) ──
  const actions = asActions(version.actions);
  if (actions.length === 0) {
    return log({ result: 'SKIPPED', conditionsMet: true, actionTaken: null, reason: 'No actions configured.' });
  }

  const performed: string[] = [];
  try {
    for (const action of actions) {
      switch (action.type) {
        case 'SEND_EMAIL': {
          const outcome = await performSendEmail({
            automation,
            version,
            record,
            conditionText: describeCondition(conditions),
            config: action.config,
          });
          performed.push(outcome);
          break;
        }
        case 'UPDATE_RECORD': {
          const updates = (action.config.fields ?? {}) as Record<string, unknown>;
          const merged = { ...data, ...updates };
          await prisma.record.update({ where: { id: recordId }, data: { data: merged as any } });
          for (const [field, newValue] of Object.entries(updates)) {
            await prisma.recordChangeHistory.create({
              data: {
                recordId,
                actorId: null,
                field,
                oldValue: (data[field] ?? null) as any,
                newValue: newValue as any,
                reason: `Automation: ${automation.name}`,
              },
            });
          }
          performed.push(`UPDATE_RECORD(${Object.keys(updates).join(', ')})`);
          break;
        }
        case 'NOTIFY_USER': {
          await prisma.notification.create({
            data: {
              workspaceId: automation.workspaceId,
              userId: (action.config.userId as string) ?? record.dataset.ownerId,
              type: 'AUTOMATION',
              title: (action.config.title as string) ?? `Automation "${automation.name}" fired`,
              body: (action.config.body as string) ?? `Record ${recordId} matched ${describeCondition(conditions)}`,
              link: `/data/${record.datasetId}`,
            },
          });
          performed.push('NOTIFY_USER');
          break;
        }
        case 'WAIT': {
          // A real delay needs a scheduled queue; rather than pretend, this
          // is recorded and skipped. Tracked in PHASE_STATUS.md.
          performed.push(`WAIT(not yet implemented — requires the delayed queue)`);
          break;
        }
        default:
          performed.push(`UNKNOWN_ACTION(${(action as any).type})`);
      }
    }
  } catch (err) {
    return log({
      result: 'ERROR',
      conditionsMet: true,
      actionTaken: performed.join('; ') || null,
      reason: (err as Error).message,
    });
  }

  return log({
    result: 'TRIGGERED',
    conditionsMet: true,
    actionTaken: performed.join('; '),
    reason: `Conditions met: ${describeCondition(conditions)}`,
  });
}

/**
 * The SEND_EMAIL action creates a real campaign/batch/job, so an
 * automation-sent email is indistinguishable from a manual one in history,
 * analytics, and the "why was this sent" trail (§35/§63).
 */
async function performSendEmail(opts: {
  automation: { id: string; name: string; organizationId: string; workspaceId: string };
  version: AutomationVersionShape;
  record: { id: string; datasetId: string; data: unknown; contactId: string | null; dataset: { ownerId: string; workspaceId: string } };
  conditionText: string;
  config: Record<string, unknown>;
}): Promise<string> {
  const { automation, record, conditionText, config } = opts;

  const templateId = config.templateId as string | undefined;
  if (!templateId) throw new Error('SEND_EMAIL action has no templateId configured.');

  const template = await prisma.template.findUnique({
    where: { id: templateId },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  const templateVersion = template?.versions[0];
  if (!template || !templateVersion) throw new Error('Configured template has no versions.');

  const owner = record.dataset.ownerId;
  const sender = await prisma.emailProviderAccount.findUnique({
    where: {
      workspaceId_userId_provider: {
        workspaceId: automation.workspaceId,
        userId: owner,
        provider: EmailProviderEnum.GMAIL,
      },
    },
  });
  if (!sender || sender.status !== 'CONNECTED') {
    throw new Error('No connected Gmail account for the dataset owner — cannot send.');
  }

  const data = (record.data ?? {}) as Record<string, unknown>;
  const emailColumn = await prisma.datasetColumn.findFirst({
    where: { datasetId: record.datasetId, type: 'EMAIL' },
    orderBy: { order: 'asc' },
  });
  const toEmail = emailColumn ? String(data[emailColumn.key] ?? '').trim() : '';
  if (!toEmail) throw new Error('Record has no email address.');

  const rendered = renderTemplate(
    { subject: templateVersion.subject, html: templateVersion.html, plainText: templateVersion.plainText },
    data
  );
  if (rendered.missingVariables.length > 0) {
    throw new Error(`Missing values for ${rendered.missingVariables.map((v) => `{{${v}}}`).join(', ')}.`);
  }

  // One campaign per automation+template, reused across firings so the
  // history groups sensibly instead of creating a campaign per record.
  const campaignName = `${automation.name} (automation)`;
  const campaign =
    (await prisma.campaign.findFirst({
      where: { workspaceId: automation.workspaceId, automationId: automation.id, templateId: template.id },
    })) ??
    (await prisma.campaign.create({
      data: {
        organizationId: automation.organizationId,
        workspaceId: automation.workspaceId,
        name: campaignName,
        datasetId: record.datasetId,
        templateId: template.id,
        templateVersionId: templateVersion.id,
        automationId: automation.id,
        createdById: owner,
        senderAccountId: sender.id,
        status: CampaignStatus.RUNNING,
      },
    }));

  const label = `AUTO-${new Date().toISOString().slice(0, 10)}`;
  const batch =
    (await prisma.batch.findFirst({
      where: { campaignId: campaign.id, label, status: { in: [BatchStatus.QUEUED, BatchStatus.RUNNING] } },
    })) ??
    (await prisma.batch.create({
      data: { campaignId: campaign.id, label, status: BatchStatus.QUEUED, total: 0, validCount: 0 },
    }));

  const sendReason = [
    `Campaign: ${campaign.name}`,
    `Automation: ${automation.name}`,
    `Condition: ${conditionText} ✓`,
    `Template: ${template.name} v${templateVersion.version}`,
    `Batch: ${batch.label}`,
    `Sender: ${sender.emailAddress}`,
  ].join('\n');

  const html = templateVersion.css ? `<style>${templateVersion.css}</style>${rendered.html}` : rendered.html;

  // §41: the unique key makes a duplicate physically impossible, so a
  // record updated twice in quick succession cannot be emailed twice.
  try {
    await prisma.emailJob.create({
      data: {
        batchId: batch.id,
        campaignId: campaign.id,
        recordId: record.id,
        templateVersionId: templateVersion.id,
        emailProviderAccountId: sender.id,
        status: EmailJobStatus.QUEUED,
        toEmail,
        ccEmails: [],
        bccEmails: [],
        fromName: sender.displayName ?? '',
        fromEmail: sender.emailAddress,
        subject: rendered.subject,
        html,
        plainText: rendered.plainText,
        sendReason,
      },
    });
  } catch (err) {
    if (String((err as Error).message).includes('Unique constraint')) {
      return 'SEND_EMAIL(skipped — already queued/sent for this record and template version)';
    }
    throw err;
  }

  await prisma.batch.update({
    where: { id: batch.id },
    data: { total: { increment: 1 }, validCount: { increment: 1 } },
  });
  await prisma.record.update({
    where: { id: record.id },
    data: { emailStatus: 'QUEUED', lastBatchId: batch.id },
  });

  return `SEND_EMAIL(queued to ${toEmail} in ${batch.label})`;
}

/**
 * Entry point called after a record is created or updated. Finds every
 * enabled automation whose trigger matches and evaluates each one.
 */
export async function onRecordChanged(opts: {
  recordId: string;
  datasetId: string;
  workspaceId: string;
  triggerType: 'RECORD_CREATED' | 'RECORD_UPDATED';
}): Promise<EvaluateResult[]> {
  const automations = await prisma.automation.findMany({
    where: {
      workspaceId: opts.workspaceId,
      enabled: true,
      OR: [{ datasetId: opts.datasetId }, { datasetId: null }],
    },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });

  const results: EvaluateResult[] = [];
  for (const automation of automations) {
    const version = automation.versions[0];
    if (!version) continue;
    // RECORD_MATCHES_CONDITIONS fires on any write; the others are explicit.
    const applies =
      version.triggerType === 'RECORD_MATCHES_CONDITIONS' || version.triggerType === opts.triggerType;
    if (!applies) continue;

    results.push(
      await evaluateAutomationForRecord({
        automationId: automation.id,
        recordId: opts.recordId,
        triggerType: opts.triggerType,
      })
    );
  }
  return results;
}
