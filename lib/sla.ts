import { ConversationStatus } from '@prisma/client';

export interface SlaRuleLike {
  firstResponseMinutes: number;
  appliesTo: string;
  tagName: string | null;
  assigneeId: string | null;
}

export interface SlaConversationLike {
  firstMessageAt: Date | null;
  status: string;
  assigneeId: string | null;
  tags: { tag: { name: string } }[];
}

const OPEN_STATUSES: string[] = [ConversationStatus.OPEN, ConversationStatus.IN_PROGRESS];

/** Worst-case first-response breach across the rules that apply to a conversation. */
export function checkSlaBreach(
  conv: SlaConversationLike,
  rules: SlaRuleLike[],
  now: Date = new Date(),
): { slaBreached: boolean; slaMinutesOverdue: number } {
  if (!OPEN_STATUSES.includes(conv.status) || !conv.firstMessageAt) {
    return { slaBreached: false, slaMinutesOverdue: 0 };
  }
  const tagNames = conv.tags.map((t) => t.tag.name.toLowerCase());
  const minutesElapsed = (now.getTime() - conv.firstMessageAt.getTime()) / 60_000;
  let maxOverdue = 0;
  for (const rule of rules) {
    const applies =
      rule.appliesTo === 'ALL' ||
      (rule.appliesTo === 'TAG' && !!rule.tagName && tagNames.includes(rule.tagName.toLowerCase())) ||
      (rule.appliesTo === 'ASSIGNEE' && rule.assigneeId === conv.assigneeId);
    if (!applies) continue;
    const overdue = minutesElapsed - rule.firstResponseMinutes;
    if (overdue > maxOverdue) maxOverdue = overdue;
  }
  return { slaBreached: maxOverdue > 0, slaMinutesOverdue: Math.round(maxOverdue) };
}
