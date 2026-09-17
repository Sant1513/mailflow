import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { ConversationStatus, MessageDirection, MessageClassification } from '@prisma/client';

const NOISE: MessageClassification[] = [
  MessageClassification.OUT_OF_OFFICE,
  MessageClassification.AUTO_REPLY,
  MessageClassification.BOUNCE,
  MessageClassification.DELIVERY_FAILURE,
];

function avgMinutes(ms: number[]): number | null {
  if (!ms.length) return null;
  return Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
}

function fmtMinutes(m: number | null): string {
  if (m === null) return '—';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = session.workspaceId;

  // ── Filters ──────────────────────────────────────────────────────────────
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');
  const assigneeId = url.searchParams.get('assigneeId'); // '' | 'none' | userId
  const statusFilter = url.searchParams.get('status');   // '' | OPEN | RESOLVED | etc.
  const tagFilter = url.searchParams.get('tag');

  const from = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 86_400_000);
  const to = toParam ? new Date(toParam) : new Date();

  const where: any = {
    workspaceId,
    createdAt: { gte: from, lte: to },
  };
  if (assigneeId === 'none') where.assigneeId = null;
  else if (assigneeId) where.assigneeId = assigneeId;
  if (statusFilter) {
    if (statusFilter === 'resolved') {
      where.status = { in: [ConversationStatus.RESOLVED, ConversationStatus.CLOSED] };
    } else if (statusFilter === 'open') {
      where.status = { in: [ConversationStatus.OPEN, ConversationStatus.IN_PROGRESS] };
    } else {
      where.status = statusFilter;
    }
  }
  if (tagFilter) where.tags = { some: { tag: { name: tagFilter } } };

  // ── Load conversations ────────────────────────────────────────────────────
  const conversations = await prisma.conversation.findMany({
    where,
    select: {
      id: true,
      status: true,
      assigneeId: true,
      assignee: { select: { id: true, name: true, email: true } },
      createdAt: true,
      updatedAt: true,
      unread: true,
      messages: {
        where: { classification: { notIn: NOISE } },
        orderBy: { sentAt: 'asc' },
        select: { direction: true, sentAt: true, receivedAt: true },
      },
    },
  });

  // ── Compute per-conversation FRT / resolution time ────────────────────────
  const resolved = new Set<ConversationStatus>([ConversationStatus.RESOLVED, ConversationStatus.CLOSED]);

  let frtValues: number[] = [];
  let artValues: number[] = [];
  let resolutionValues: number[] = [];
  let respondedCount = 0;

  const agentMap = new Map<string, {
    user: { id: string; name: string | null; email: string };
    total: number;
    responded: number;
    frt: number[];
    art: number[];
    resolvedCount: number;
  }>();

  // Day-by-day buckets
  const dayBuckets = new Map<string, { opened: number; resolved: number; }>();
  const cursor = new Date(from);
  while (cursor <= to) {
    dayBuckets.set(cursor.toISOString().slice(0, 10), { opened: 0, resolved: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const conv of conversations) {
    const dayKey = conv.createdAt.toISOString().slice(0, 10);
    if (dayBuckets.has(dayKey)) dayBuckets.get(dayKey)!.opened++;
    if (resolved.has(conv.status)) {
      const rKey = conv.updatedAt.toISOString().slice(0, 10);
      if (dayBuckets.has(rKey)) dayBuckets.get(rKey)!.resolved++;
      const resMs = (conv.updatedAt.getTime() - conv.createdAt.getTime()) / 60_000;
      resolutionValues.push(resMs);
    }

    // FRT: first inbound → first outbound
    const inbound = conv.messages.filter((m) => m.direction === MessageDirection.INBOUND);
    const outbound = conv.messages.filter((m) => m.direction === MessageDirection.OUTBOUND);
    const firstIn = inbound[0]?.receivedAt ?? inbound[0]?.sentAt;
    const firstOut = outbound[0]?.sentAt;
    let frt: number | null = null;
    if (firstIn && firstOut && firstOut > firstIn) {
      frt = (firstOut.getTime() - firstIn.getTime()) / 60_000;
      frtValues.push(frt);
    }

    // ART: avg time between consecutive in→out pairs
    const pairs: number[] = [];
    for (let i = 0; i < conv.messages.length - 1; i++) {
      const a = conv.messages[i]!;
      const b = conv.messages[i + 1]!;
      if (a.direction === MessageDirection.INBOUND && b.direction === MessageDirection.OUTBOUND) {
        const at = a.receivedAt ?? a.sentAt;
        const bt = b.sentAt;
        if (at && bt && bt > at) pairs.push((bt.getTime() - at.getTime()) / 60_000);
      }
    }
    if (pairs.length) {
      const art = pairs.reduce((s, v) => s + v, 0) / pairs.length;
      artValues.push(art);
      respondedCount++;
    }

    // Per-agent tracking
    if (conv.assigneeId && conv.assignee) {
      const uid = conv.assigneeId;
      if (!agentMap.has(uid)) {
        agentMap.set(uid, { user: conv.assignee, total: 0, responded: 0, frt: [], art: [], resolvedCount: 0 });
      }
      const ag = agentMap.get(uid)!;
      ag.total++;
      if (frt !== null) ag.frt.push(frt);
      if (pairs.length) { ag.art.push(...pairs); ag.responded++; }
      if (resolved.has(conv.status)) ag.resolvedCount++;
    }
  }

  const total = conversations.length;
  const resolvedCount = conversations.filter((c) => resolved.has(c.status)).length;
  const openCount = conversations.filter((c) => !resolved.has(c.status)).length;
  const unreadCount = conversations.filter((c) => c.unread).length;

  const agents = [...agentMap.values()].map(({ user, total: t, responded, frt, art, resolvedCount: rc }) => ({
    userId: user.id,
    name: user.name ?? user.email,
    email: user.email,
    total: t,
    responded,
    resolvedCount: rc,
    resolutionRate: t > 0 ? Math.round((rc / t) * 100) : 0,
    frtMinutes: avgMinutes(frt),
    frtFormatted: fmtMinutes(avgMinutes(frt)),
    artMinutes: avgMinutes(art),
    artFormatted: fmtMinutes(avgMinutes(art)),
  })).sort((a, b) => b.total - a.total);

  const trend = [...dayBuckets.entries()].map(([day, v]) => ({ day, ...v }));

  return NextResponse.json({
    kpis: {
      total,
      openCount,
      resolvedCount,
      unreadCount,
      resolutionRate: total > 0 ? Math.round((resolvedCount / total) * 100) : 0,
      replyRate: total > 0 ? Math.round((respondedCount / total) * 100) : 0,
      frtMinutes: avgMinutes(frtValues),
      frtFormatted: fmtMinutes(avgMinutes(frtValues)),
      artMinutes: avgMinutes(artValues),
      artFormatted: fmtMinutes(avgMinutes(artValues)),
      resolutionMinutes: avgMinutes(resolutionValues),
      resolutionFormatted: fmtMinutes(avgMinutes(resolutionValues)),
    },
    agents,
    trend,
  });
});
