import { prisma } from '@/lib/db/client';
import { EmailJobStatus, MessageDirection, MessageClassification } from '@prisma/client';
import {
  bucketByDay,
  failureRateByDay,
  overallFailurePct,
  windowStart,
  type DayPoint,
  type FailureRatePoint,
} from '@/lib/analytics/series';

/**
 * §85/§86/§127 numbers. Every figure here is a real count over real rows —
 * nothing is estimated or sampled — and every query is scoped by
 * organization or workspace so a workspace dashboard can never see
 * another workspace's traffic.
 *
 * Volumes are bounded by the day window, and the per-day series are
 * bucketed in JS from `select: { sentAt }` rows rather than a raw SQL
 * date_trunc, so the same code runs against any Postgres and stays under
 * Prisma's typed client.
 */

export type Scope = { organizationId: string } | { workspaceId: string };

function jobScope(scope: Scope) {
  return 'workspaceId' in scope
    ? { campaign: { workspaceId: scope.workspaceId } }
    : { campaign: { organizationId: scope.organizationId } };
}

function conversationScope(scope: Scope) {
  return 'workspaceId' in scope
    ? { workspaceId: scope.workspaceId }
    : { organizationId: scope.organizationId };
}

export interface Totals {
  emailsSent: number;
  emailsPending: number;
  emailsFailed: number;
  replies: number;
  unread: number;
  openConversations: number;
  resolvedConversations: number;
  followUpsDue: number;
}

export async function totals(scope: Scope, now = new Date()): Promise<Totals> {
  const jobWhere = jobScope(scope);
  const convWhere = conversationScope(scope);
  const [
    emailsSent,
    emailsPending,
    emailsFailed,
    replies,
    unread,
    openConversations,
    resolvedConversations,
    followUpsDue,
  ] = await Promise.all([
    prisma.emailJob.count({ where: { ...jobWhere, status: EmailJobStatus.SENT } }),
    prisma.emailJob.count({
      where: { ...jobWhere, status: { in: [EmailJobStatus.QUEUED, EmailJobStatus.SENDING] } },
    }),
    prisma.emailJob.count({ where: { ...jobWhere, status: EmailJobStatus.FAILED } }),
    prisma.conversationMessage.count({
      where: {
        conversation: convWhere,
        direction: MessageDirection.INBOUND,
        classification: MessageClassification.HUMAN_REPLY,
      },
    }),
    prisma.conversation.count({ where: { ...convWhere, unread: true } }),
    prisma.conversation.count({
      where: { ...convWhere, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_STUDENT'] } },
    }),
    prisma.conversation.count({ where: { ...convWhere, status: { in: ['RESOLVED', 'CLOSED'] } } }),
    prisma.followUp.count({
      where: { conversation: convWhere, completed: false, dueDate: { lte: now } },
    }),
  ]);
  return {
    emailsSent,
    emailsPending,
    emailsFailed,
    replies,
    unread,
    openConversations,
    resolvedConversations,
    followUpsDue,
  };
}

export interface DailySeries {
  days: number;
  emailsByDay: DayPoint[];
  repliesByDay: DayPoint[];
  failureByDay: FailureRatePoint[];
  /** Window-wide failure percentage, null if nothing was attempted. */
  failurePct: number | null;
}

export async function dailySeries(scope: Scope, days: number, now = new Date()): Promise<DailySeries> {
  const since = windowStart(days, now);
  const jobWhere = jobScope(scope);
  const convWhere = conversationScope(scope);

  const [sentRows, failedRows, replyRows] = await Promise.all([
    prisma.emailJob.findMany({
      where: { ...jobWhere, status: EmailJobStatus.SENT, sentAt: { gte: since } },
      select: { sentAt: true },
    }),
    prisma.emailJob.findMany({
      where: { ...jobWhere, status: EmailJobStatus.FAILED, lastAttemptAt: { gte: since } },
      select: { lastAttemptAt: true },
    }),
    prisma.conversationMessage.findMany({
      where: {
        conversation: convWhere,
        direction: MessageDirection.INBOUND,
        classification: MessageClassification.HUMAN_REPLY,
        receivedAt: { gte: since },
      },
      select: { receivedAt: true },
    }),
  ]);

  const emailsByDay = bucketByDay(sentRows.map((r) => r.sentAt), days, now);
  const failedByDay = bucketByDay(failedRows.map((r) => r.lastAttemptAt), days, now);
  const repliesByDay = bucketByDay(replyRows.map((r) => r.receivedAt), days, now);
  const sentTotal = emailsByDay.reduce((a, p) => a + p.value, 0);
  const failedTotal = failedByDay.reduce((a, p) => a + p.value, 0);

  return {
    days,
    emailsByDay,
    repliesByDay,
    failureByDay: failureRateByDay(emailsByDay, failedByDay),
    failurePct: overallFailurePct(sentTotal, failedTotal),
  };
}

export interface CampaignPerformanceRow {
  id: string;
  name: string;
  status: string;
  workspaceName: string;
  sent: number;
  failed: number;
  skipped: number;
  failurePct: number | null;
  updatedAt: Date;
}

/** §127 "Campaign performance": the most recently active campaigns with real job counts. */
export async function campaignPerformance(scope: Scope, limit = 10): Promise<CampaignPerformanceRow[]> {
  const where = 'workspaceId' in scope ? { workspaceId: scope.workspaceId } : { organizationId: scope.organizationId };
  const campaigns = await prisma.campaign.findMany({
    where: { ...where, status: { notIn: ['DRAFT'] } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true, name: true, status: true, updatedAt: true, workspace: { select: { name: true } } },
  });
  if (campaigns.length === 0) return [];

  const grouped = await prisma.emailJob.groupBy({
    by: ['campaignId', 'status'],
    where: { campaignId: { in: campaigns.map((c) => c.id) } },
    _count: { _all: true },
  });
  const count = (id: string, status: EmailJobStatus) =>
    grouped.find((g) => g.campaignId === id && g.status === status)?._count._all ?? 0;

  return campaigns.map((c) => {
    const sent = count(c.id, EmailJobStatus.SENT);
    const failed = count(c.id, EmailJobStatus.FAILED);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      workspaceName: c.workspace.name,
      sent,
      failed,
      skipped: count(c.id, EmailJobStatus.SKIPPED),
      failurePct: overallFailurePct(sent, failed),
      updatedAt: c.updatedAt,
    };
  });
}

export interface UserActivityRow {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: Date | null;
  /** Audited actions by this user inside the window. */
  actions: number;
  emailsSent: number;
}

/** §127 "User activity": audited actions + emails sent per user in the window. */
export async function userActivity(organizationId: string, days: number, now = new Date()): Promise<UserActivityRow[]> {
  const since = windowStart(days, now);
  const [users, actions, sent] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId },
      orderBy: { lastLoginAt: { sort: 'desc', nulls: 'last' } },
      select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true },
    }),
    prisma.auditLog.groupBy({
      by: ['actorId'],
      where: { organizationId, createdAt: { gte: since }, actorId: { not: null } },
      _count: { _all: true },
    }),
    prisma.emailJob.groupBy({
      by: ['campaignId'],
      where: { campaign: { organizationId }, status: EmailJobStatus.SENT, sentAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  // Emails are attributed to the campaign creator — the person who pressed send.
  const creators = sent.length
    ? await prisma.campaign.findMany({
        where: { id: { in: sent.map((s) => s.campaignId) } },
        select: { id: true, createdById: true },
      })
    : [];
  const sentByUser = new Map<string, number>();
  for (const s of sent) {
    const creator = creators.find((c) => c.id === s.campaignId)?.createdById;
    if (creator) sentByUser.set(creator, (sentByUser.get(creator) ?? 0) + s._count._all);
  }
  const actionsByUser = new Map(actions.map((a) => [a.actorId as string, a._count._all]));

  return users.map((u) => ({
    ...u,
    actions: actionsByUser.get(u.id) ?? 0,
    emailsSent: sentByUser.get(u.id) ?? 0,
  }));
}

export interface OrgCounts {
  users: number;
  activeUsers: number;
  workspaces: number;
  contacts: number;
  datasets: number;
  campaigns: number;
  aiCalls: number;
}

export async function orgCounts(organizationId: string, days: number, now = new Date()): Promise<OrgCounts> {
  const since = windowStart(days, now);
  const [users, activeUsers, workspaces, contacts, datasets, campaigns, aiCalls] = await Promise.all([
    prisma.user.count({ where: { organizationId } }),
    prisma.user.count({ where: { organizationId, status: 'ACTIVE', lastLoginAt: { gte: since } } }),
    prisma.workspace.count({ where: { organizationId } }),
    prisma.contact.count({ where: { organizationId } }),
    prisma.dataset.count({ where: { workspace: { organizationId } } }),
    prisma.campaign.count({ where: { organizationId } }),
    prisma.aiUsage.count({ where: { organizationId, createdAt: { gte: since } } }),
  ]);
  return { users, activeUsers, workspaces, contacts, datasets, campaigns, aiCalls };
}

/** Clamp the `?days=` query to the supported presets so a URL can't ask for 10 years. */
export function parseDays(raw: string | string[] | undefined, fallback = 30): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return [7, 30, 90].includes(n) ? n : fallback;
}
