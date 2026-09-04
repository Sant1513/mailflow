import { evaluateCondition, describeCondition, type Condition } from './conditions';

/**
 * §37 send-frequency protection and §71 stop conditions.
 *
 * These are the rails that stop an automation mailing the same student
 * every time a record is touched. Pure functions, so the decision is
 * identical in the "how many would this affect" preview and in the live
 * evaluation.
 */

export type FrequencyMode =
  | 'ONCE' // ever, for this automation
  | 'ONCE_PER_DAY'
  | 'ONCE_PER_WEEK'
  | 'ONCE_PER_CAMPAIGN'
  | 'ALLOW_REPEATED';

export interface FrequencyPolicy {
  mode: FrequencyMode;
  /** Additional "do not send again within N days" guard (§37). */
  cooldownDays?: number;
}

export interface PriorSend {
  sentAt: Date;
  campaignId?: string | null;
}

export interface FrequencyDecision {
  allowed: boolean;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function checkFrequency(
  policy: FrequencyPolicy,
  priorSends: PriorSend[],
  context: { now?: Date; campaignId?: string | null } = {}
): FrequencyDecision {
  const now = context.now ?? new Date();

  // The cooldown applies on top of every mode except ALLOW_REPEATED, so a
  // "once per day" automation with a 7-day cooldown honours the longer of
  // the two rather than the looser.
  if (policy.cooldownDays && policy.cooldownDays > 0 && policy.mode !== 'ALLOW_REPEATED') {
    const cutoff = new Date(now.getTime() - policy.cooldownDays * DAY_MS);
    const recent = priorSends.find((send) => send.sentAt > cutoff);
    if (recent) {
      return {
        allowed: false,
        reason: `Already emailed on ${recent.sentAt.toISOString().slice(0, 10)}; the ${policy.cooldownDays}-day cooldown has not elapsed.`,
      };
    }
  }

  switch (policy.mode) {
    case 'ALLOW_REPEATED':
      return { allowed: true, reason: 'Repeated sends are allowed for this automation.' };

    case 'ONCE': {
      if (priorSends.length > 0) {
        return {
          allowed: false,
          reason: `This automation sends once per record, and this record was already emailed on ${priorSends[0]!.sentAt.toISOString().slice(0, 10)}.`,
        };
      }
      return { allowed: true, reason: 'No previous send for this record.' };
    }

    case 'ONCE_PER_DAY': {
      const cutoff = new Date(now.getTime() - DAY_MS);
      const recent = priorSends.find((send) => send.sentAt > cutoff);
      return recent
        ? { allowed: false, reason: 'Already emailed within the last 24 hours.' }
        : { allowed: true, reason: 'No send in the last 24 hours.' };
    }

    case 'ONCE_PER_WEEK': {
      const cutoff = new Date(now.getTime() - 7 * DAY_MS);
      const recent = priorSends.find((send) => send.sentAt > cutoff);
      return recent
        ? { allowed: false, reason: 'Already emailed within the last 7 days.' }
        : { allowed: true, reason: 'No send in the last 7 days.' };
    }

    case 'ONCE_PER_CAMPAIGN': {
      if (!context.campaignId) return { allowed: true, reason: 'No campaign context; not limited.' };
      const already = priorSends.find((send) => send.campaignId === context.campaignId);
      return already
        ? { allowed: false, reason: 'Already emailed as part of this campaign.' }
        : { allowed: true, reason: 'Not yet emailed for this campaign.' };
    }

    default:
      // Unknown mode blocks rather than sends — failing closed is the only
      // safe default when the rule governing mass email is unrecognized.
      return { allowed: false, reason: `Unrecognized send-frequency mode; blocking as a precaution.` };
  }
}

export interface StopDecision {
  stopped: boolean;
  reason: string;
}

/**
 * §71: evaluated before the action runs. If the stop condition matches, the
 * automation does nothing for this record — e.g. "stop if Reply Received =
 * Yes" prevents chasing a student who already answered.
 */
export function checkStopConditions(
  stopConditions: Condition | null | undefined,
  data: Record<string, unknown>
): StopDecision {
  if (!stopConditions) return { stopped: false, reason: 'No stop conditions configured.' };

  const matched = evaluateCondition(stopConditions, data);
  return matched
    ? { stopped: true, reason: `Stop condition met: ${describeCondition(stopConditions)}` }
    : { stopped: false, reason: `Stop condition not met: ${describeCondition(stopConditions)}` };
}
