/**
 * §83 AI provider abstraction. Everything the app asks of an AI goes
 * through this interface so GeminiProvider can be swapped for another
 * provider without touching a route or a page.
 *
 * Providers receive already-minimised, already-redacted context (see
 * lib/ai/prompts.ts) — they never see tokens, secrets or raw records (§81).
 */

export type AiFeature =
  | 'generate_email'
  | 'improve_text'
  | 'subject_lines'
  | 'check_personalization'
  | 'suggest_reply'
  | 'summarize_conversation'
  | 'classify_reply'
  | 'summarize_campaign'
  | 'explain_send'
  | 'explain_automation';

export const AI_FEATURES: AiFeature[] = [
  'generate_email',
  'improve_text',
  'subject_lines',
  'check_personalization',
  'suggest_reply',
  'summarize_conversation',
  'classify_reply',
  'summarize_campaign',
  'explain_send',
  'explain_automation',
];

export type Tone = 'professional' | 'friendly' | 'urgent' | 'neutral';

export interface GenerateEmailInput {
  /** What the user typed, e.g. "reminder for students who have not completed RPG". */
  brief: string;
  tone?: Tone;
  /** Template variables that exist on the dataset, e.g. ["Name", "Deadline"]. */
  variables: string[];
  senderName?: string;
  orgName?: string;
}

export interface GeneratedEmail {
  subject: string;
  previewText: string;
  plainText: string;
  html: string;
  /** Variables the copy actually uses — a subset of the input list. */
  usedVariables: string[];
}

export type ImproveMode =
  | 'improve'
  | 'shorten'
  | 'professional'
  | 'friendly'
  | 'formal'
  | 'rewrite'
  | 'grammar'
  | 'translate'
  | 'cta';

export const IMPROVE_MODES: ImproveMode[] = [
  'improve',
  'shorten',
  'professional',
  'friendly',
  'formal',
  'rewrite',
  'grammar',
  'translate',
  'cta',
];

export interface ImproveTextInput {
  text: string;
  mode: ImproveMode;
  format: 'html' | 'text';
  /** Target language for `translate`. */
  language?: string;
  /** Variables that must be preserved verbatim. */
  variables: string[];
}

export interface ImprovedText {
  text: string;
  /** Short bullet notes of what changed, for the user to review. */
  changes: string[];
}

export interface SubjectLinesInput {
  brief: string;
  body?: string;
  variables: string[];
  count?: number;
}

export interface PersonalizationCheckInput {
  subject: string;
  body: string;
  /** Variables available on the dataset. */
  availableVariables: string[];
  /** Variables the template references (computed locally, not by the AI). */
  usedVariables: string[];
}

export interface PersonalizationCheck {
  score: number; // 0–100
  findings: string[];
  suggestions: string[];
}

/** One turn of a conversation, already minimised and redacted. */
export interface ContextMessage {
  from: 'student' | 'team';
  at: string; // ISO
  text: string;
}

export interface ConversationContext {
  recipientFirstName: string;
  senderName: string;
  subject: string;
  messages: ContextMessage[];
}

export interface ConversationSummary {
  summary: string;
  suggestedNextAction: string;
  /** A status the human may choose to apply. Never applied automatically (§79). */
  suggestedStatus: 'OPEN' | 'IN_PROGRESS' | 'WAITING_FOR_STUDENT' | 'RESOLVED' | null;
}

/** §80 intent labels. Stored alongside, never instead of, the header-first classification. */
export type ReplyIntent =
  | 'COMPLETED'
  | 'QUESTION'
  | 'REQUEST'
  | 'COMPLAINT'
  | 'ACKNOWLEDGEMENT'
  | 'NEEDS_ACTION'
  | 'OUT_OF_OFFICE'
  | 'AUTO_REPLY'
  | 'UNKNOWN';

export const REPLY_INTENTS: ReplyIntent[] = [
  'COMPLETED',
  'QUESTION',
  'REQUEST',
  'COMPLAINT',
  'ACKNOWLEDGEMENT',
  'NEEDS_ACTION',
  'OUT_OF_OFFICE',
  'AUTO_REPLY',
  'UNKNOWN',
];

export interface ReplyClassification {
  intent: ReplyIntent;
  confidence: number; // 0–1
  reason: string;
}

export type ReplyStyle = 'default' | 'shorter' | 'formal';

export interface SuggestedReply {
  text: string;
}

export interface CampaignDigestInput {
  name: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
  /** Distinct error messages with counts, already truncated. */
  topErrors: { message: string; count: number }[];
  topSkipReasons: { reason: string; count: number }[];
  replies: number;
}

export interface Explanation {
  explanation: string;
  /** Concrete, human-actionable next steps. */
  nextSteps: string[];
}

export interface AiUsageMeta {
  provider: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
}

export interface AiResult<T> {
  data: T;
  usage: AiUsageMeta;
}

export type AiErrorKind =
  | 'NOT_CONFIGURED'
  | 'DISABLED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'BAD_RESPONSE'
  | 'SAFETY';

/** The only error type providers throw; the service layer maps it to a graceful message (§82). */
export class AiError extends Error {
  constructor(
    public kind: AiErrorKind,
    message: string,
    public opts: { status?: number; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'AiError';
  }
  get retryable() {
    return this.opts.retryable ?? false;
  }
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateText(prompt: string, opts?: { system?: string; maxOutputTokens?: number }): Promise<AiResult<string>>;
  generateEmail(input: GenerateEmailInput): Promise<AiResult<GeneratedEmail>>;
  improveText(input: ImproveTextInput): Promise<AiResult<ImprovedText>>;
  subjectLines(input: SubjectLinesInput): Promise<AiResult<string[]>>;
  checkPersonalization(input: PersonalizationCheckInput): Promise<AiResult<PersonalizationCheck>>;
  summarizeConversation(ctx: ConversationContext): Promise<AiResult<ConversationSummary>>;
  classifyReply(ctx: ConversationContext): Promise<AiResult<ReplyClassification>>;
  suggestReply(ctx: ConversationContext, style?: ReplyStyle): Promise<AiResult<SuggestedReply>>;
  summarizeCampaign(input: CampaignDigestInput): Promise<AiResult<Explanation>>;
  explain(question: string, facts: Record<string, unknown>): Promise<AiResult<Explanation>>;
}
