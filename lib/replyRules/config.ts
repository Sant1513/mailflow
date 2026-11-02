import { z } from 'zod';

/**
 * "When someone replies" — per-campaign follow-up branches by reply type. The AI reads every
 * human reply and gives it an intent (lib/ai/prompts.ts); the first rule whose reply types
 * include that intent, at or above its confidence, runs its actions. Example:
 *   Interested     → reply with "Next steps" (for approval), set Status = Interested, assign Asha
 *   Not interested → set Status = Not interested, stop follow-ups, close the conversation
 *   Question       → assign to the placement desk (the AI still drafts an answer)
 */

export const REPLY_TYPES = {
  INTERESTED: 'Interested / says yes',
  NOT_INTERESTED: 'Not interested / says no',
  QUESTION: 'Asks a question',
  REQUEST: 'Asks for something',
  COMPLAINT: 'Complains',
  NEEDS_ACTION: 'Needs action from the team',
  COMPLETED: 'Done what was asked',
  ACKNOWLEDGEMENT: 'Just says thanks / ok',
  OUT_OF_OFFICE: 'Out of office',
} as const;
export type ReplyType = keyof typeof REPLY_TYPES;
const replyType = z.enum(Object.keys(REPLY_TYPES) as [ReplyType, ...ReplyType[]]);

export const replyRuleSchema = z.object({
  id: z.string().min(1).max(40),
  /** Reply types this rule handles. */
  when: z.array(replyType).min(1),
  /** Only act when the AI is at least this sure (0.5–1). */
  minConfidence: z.number().min(0.5).max(1).default(0.7),
  actions: z.object({
    /** Answer with a template (rendered with the person's data), in the same thread. */
    replyTemplateId: z.string().nullable().default(null),
    /** draft = waits for a person to approve (Inbox shows "Approve & send"); auto = sends at once. */
    replyMode: z.enum(['draft', 'auto']).default('draft'),
    /** Write a value to a data column on the person's row (created if missing). */
    setColumn: z.string().max(100).nullable().default(null),
    setValue: z.string().max(500).default(''),
    assignTo: z.string().nullable().default(null),
    addTag: z.string().max(40).nullable().default(null),
    setStatus: z.enum(['RESOLVED', 'WAITING_FOR_STUDENT', 'IN_PROGRESS']).nullable().default(null),
    /** Cancel open follow-up reminders and scheduled replies on the conversation. */
    stopFollowUps: z.boolean().default(false),
    /** Add the address to the do-not-email list (e.g. "please remove me"). */
    unsubscribe: z.boolean().default(false),
    /** Notify the campaign owner in MailFlow. */
    notifyOwner: z.boolean().default(false),
  }),
});

export const replyRulesSchema = z.object({
  enabled: z.boolean(),
  rules: z.array(replyRuleSchema).max(12),
});

export type ReplyRule = z.infer<typeof replyRuleSchema>;
export type ReplyRules = z.infer<typeof replyRulesSchema>;

export function readReplyRules(value: unknown): ReplyRules | null {
  const parsed = replyRulesSchema.safeParse(value);
  return parsed.success && parsed.data.enabled && parsed.data.rules.length ? parsed.data : null;
}

/** The rule to run for a reply, or null. First match wins. */
export function pickRule(rules: ReplyRules, intent: string, confidence: number): ReplyRule | null {
  return rules.rules.find((r) => (r.when as string[]).includes(intent) && confidence >= r.minConfidence) ?? null;
}

export function exampleReplyRules(): ReplyRules {
  return {
    enabled: true,
    rules: [
      {
        id: 'interested', when: ['INTERESTED'], minConfidence: 0.7,
        actions: { replyTemplateId: null, replyMode: 'draft', setColumn: 'Reply status', setValue: 'Interested', assignTo: null, addTag: 'Interested', setStatus: null, stopFollowUps: false, unsubscribe: false, notifyOwner: true },
      },
      {
        id: 'not_interested', when: ['NOT_INTERESTED'], minConfidence: 0.7,
        actions: { replyTemplateId: null, replyMode: 'draft', setColumn: 'Reply status', setValue: 'Not interested', assignTo: null, addTag: null, setStatus: 'RESOLVED', stopFollowUps: true, unsubscribe: false, notifyOwner: false },
      },
      {
        id: 'question', when: ['QUESTION', 'REQUEST'], minConfidence: 0.6,
        actions: { replyTemplateId: null, replyMode: 'draft', setColumn: null, setValue: '', assignTo: null, addTag: null, setStatus: 'IN_PROGRESS', stopFollowUps: false, unsubscribe: false, notifyOwner: true },
      },
    ],
  };
}
