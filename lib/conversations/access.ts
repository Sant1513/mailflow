import { prisma } from '@/lib/db/client';
import { ForbiddenError, type AppSession } from '@/lib/auth/session';
import { Role } from '@prisma/client';

/**
 * Who may do what with a conversation, decided in one place (§94).
 *
 *   FULL  — the conversation's own workspace, or a SUPER_ADMIN: everything.
 *   REPLY — a teammate the owner shared their inbox with at "can reply" (Settings → Inbox
 *           sharing): reply in the same thread from the owner's mailbox, notes, status, tags.
 *   WORK  — the assignee (without a share): notes, status, tags; replies go from their own
 *           mailbox as a new email, because Gmail won't continue another account's thread.
 *   VIEW  — a teammate the owner shared with at "can view": read only.
 *
 * In lib/ because Next.js route files may only export HTTP handlers.
 */
export type ConversationAccess = 'FULL' | 'REPLY' | 'WORK' | 'VIEW';
const RANK: Record<ConversationAccess, number> = { VIEW: 1, WORK: 2, REPLY: 3, FULL: 4 };

export function atLeast(access: ConversationAccess | null, needed: ConversationAccess): boolean {
  return !!access && RANK[access] >= RANK[needed];
}

/** Pure part of the rule, so it can be tested without a database. */
export function decideAccess(
  session: Pick<AppSession, 'workspaceId' | 'userId' | 'role'>,
  conv: { workspaceId: string; ownerId: string; assigneeId: string | null },
  shareLevels: string[],
): ConversationAccess | null {
  if (conv.workspaceId === session.workspaceId || session.role === Role.SUPER_ADMIN) return 'FULL';
  let best: ConversationAccess | null = null;
  const consider = (a: ConversationAccess) => {
    if (!best || RANK[a] > RANK[best]) best = a;
  };
  if (conv.assigneeId && conv.assigneeId === session.userId) consider('WORK');
  for (const level of shareLevels) consider(level === 'REPLY' ? 'REPLY' : 'VIEW');
  return best;
}

/** The share levels the owner granted this user (directly or to everyone in the organization). */
export async function shareLevelsFor(session: Pick<AppSession, 'userId' | 'organizationId'>, ownerId: string): Promise<string[]> {
  if (ownerId === session.userId) return [];
  const shares = await prisma.inboxShare.findMany({
    where: { ownerId, organizationId: session.organizationId, OR: [{ granteeId: session.userId }, { granteeId: null }] },
    select: { level: true },
  });
  return shares.map((s) => s.level);
}

export async function accessFor(
  session: AppSession,
  conv: { workspaceId: string; ownerId: string; assigneeId: string | null },
): Promise<ConversationAccess | null> {
  const quick = decideAccess(session, conv, []);
  if (quick === 'FULL') return quick;
  return decideAccess(session, conv, await shareLevelsFor(session, conv.ownerId));
}

/** Owners (user ids) whose inboxes this user can see through a share. */
export async function ownersSharingWith(session: Pick<AppSession, 'userId' | 'organizationId'>): Promise<string[]> {
  const shares = await prisma.inboxShare.findMany({
    where: { organizationId: session.organizationId, ownerId: { not: session.userId }, OR: [{ granteeId: session.userId }, { granteeId: null }] },
    select: { ownerId: true },
  });
  return [...new Set(shares.map((s) => s.ownerId))];
}

/**
 * Loads a conversation with everything the detail view needs, and the caller's access to it.
 * Throws ForbiddenError when the caller's access is below `needed`.
 */
export async function loadConversationForSession(session: AppSession, conversationId: string, needed: ConversationAccess = 'VIEW') {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      contact: true,
      account: { select: { id: true, emailAddress: true, displayName: true, status: true } },
      assignee: { select: { id: true, name: true, email: true } },
      messages: { orderBy: { sentAt: 'asc' }, include: { attachments: true } },
      notes: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, name: true } } } },
      tags: { include: { tag: true } },
      followUps: { orderBy: { dueDate: 'asc' } },
    },
  });
  if (!conversation) return null;
  const access = await accessFor(session, conversation);
  if (!access) throw new ForbiddenError('Not your workspace');
  if (!atLeast(access, needed)) {
    throw new ForbiddenError(access === 'VIEW' ? 'This conversation was shared with you as view-only.' : 'You do not have permission to do that here.');
  }
  return Object.assign(conversation, { access });
}

export type LoadedConversation = NonNullable<Awaited<ReturnType<typeof loadConversationForSession>>>;
