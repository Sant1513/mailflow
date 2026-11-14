/**
 * One email can reach several connected mailboxes (a Google group address plus a CC, two group
 * members) and each mailbox syncs its own copy. The copies carry the same Message-ID header, so
 * that header is what says "this is the same email".
 */

/** Message-ID without angle brackets or surrounding space, lower-cased. '' when there is none. */
export function normalizeMessageId(header: string | null | undefined): string {
  if (!header) return '';
  return header.trim().replace(/^<+/, '').replace(/>+$/, '').trim().toLowerCase();
}

/**
 * The spellings to look up with an index-friendly `in` filter: as stored (trimmed), with and
 * without brackets, and lower-cased. Gmail keeps the sender's header as is, so copies of one email
 * are byte-identical in practice; the lower-cased forms cover mail that was re-written on the way.
 */
export function messageIdVariants(header: string | null | undefined): string[] {
  const raw = (header ?? '').trim();
  const core = normalizeMessageId(header);
  if (!core) return [];
  const bare = raw.replace(/^<+/, '').replace(/>+$/, '').trim();
  return Array.from(new Set([raw, `<${bare}>`, bare, core, `<${core}>`]));
}

export type DuplicateCandidate = {
  conversationId: string;
  workspaceId: string;
  mailboxId: string;
  messageIdHeader: string | null;
  createdAt: Date;
};

/**
 * Groups inbound messages that are the same email delivered to different mailboxes of one
 * workspace. Within a group the oldest copy comes first (it is the one to keep). Groups with a
 * single mailbox are not duplicates of this kind and are dropped; so are messages with no Message-ID.
 */
export function groupCrossMailboxDuplicates<T extends DuplicateCandidate>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = normalizeMessageId(row.messageIdHeader);
    if (!id) continue;
    const key = `${row.workspaceId}\u0000${id}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const out: T[][] = [];
  for (const list of groups.values()) {
    if (new Set(list.map((r) => r.mailboxId)).size < 2) continue;
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.conversationId.localeCompare(b.conversationId));
    out.push(list);
  }
  return out;
}

export type ConversationFacts = {
  inboundCount: number;
  outboundCount: number;
  notes: number;
  tags: number;
  followUps: number;
  scheduledReplies: number;
  assigneeId: string | null;
};

/** Why a later copy cannot be removed automatically ([] means it is a pure duplicate). */
export function mergeBlockers(facts: ConversationFacts): string[] {
  const why: string[] = [];
  if (facts.inboundCount !== 1) why.push(`${facts.inboundCount} inbound messages`);
  if (facts.outboundCount > 0) why.push(`${facts.outboundCount} outbound messages (replies)`);
  if (facts.notes > 0) why.push(`${facts.notes} internal notes`);
  if (facts.tags > 0) why.push(`${facts.tags} tags`);
  if (facts.followUps > 0) why.push(`${facts.followUps} follow-ups`);
  if (facts.scheduledReplies > 0) why.push(`${facts.scheduledReplies} scheduled replies`);
  if (facts.assigneeId) why.push('has an assignee');
  return why;
}
