import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { ConversationStatus } from '@prisma/client';

/**
 * Daily SLA breach check. Finds all active SLA rules, evaluates each open
 * conversation against them, and logs a summary. Called by Vercel Cron at
 * 08:00 UTC; can also be triggered manually with the CRON_SECRET.
 */
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}` || new URL(req.url).searchParams.get('secret') === secret;
}

export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const now = new Date();

  // Fetch all active SLA rules grouped by workspace
  const rules = await prisma.slaRule.findMany({
    where: { active: true },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      firstResponseMinutes: true,
      resolutionMinutes: true,
      appliesTo: true,
      tagName: true,
      assigneeId: true,
    },
  });

  if (rules.length === 0) {
    return NextResponse.json({ checkedAt: now, totalRules: 0, breachedCount: 0, results: [] });
  }

  // Collect unique workspace ids
  const workspaceIds = [...new Set(rules.map((r) => r.workspaceId))];

  // Fetch all open conversations for those workspaces
  const conversations = await prisma.conversation.findMany({
    where: {
      workspaceId: { in: workspaceIds },
      status: { in: [ConversationStatus.OPEN, ConversationStatus.IN_PROGRESS] },
      firstMessageAt: { not: null },
    },
    select: {
      id: true,
      workspaceId: true,
      assigneeId: true,
      firstMessageAt: true,
      tags: { include: { tag: { select: { name: true } } } },
    },
  });

  const results: { ruleId: string; ruleName: string; breachedConversationIds: string[] }[] = [];

  for (const rule of rules) {
    const breachedIds: string[] = [];

    for (const conv of conversations) {
      if (conv.workspaceId !== rule.workspaceId) continue;
      if (!conv.firstMessageAt) continue;

      const tagNames = conv.tags.map((t) => t.tag.name.toLowerCase());
      const applies =
        rule.appliesTo === 'ALL' ||
        (rule.appliesTo === 'TAG' && rule.tagName && tagNames.includes(rule.tagName.toLowerCase())) ||
        (rule.appliesTo === 'ASSIGNEE' && rule.assigneeId === conv.assigneeId);

      if (!applies) continue;

      const minutesElapsed = (now.getTime() - conv.firstMessageAt.getTime()) / 60_000;
      if (minutesElapsed > rule.firstResponseMinutes) {
        breachedIds.push(conv.id);
      }
    }

    results.push({ ruleId: rule.id, ruleName: rule.name, breachedConversationIds: breachedIds });
  }

  const breachedCount = results.reduce((sum, r) => sum + r.breachedConversationIds.length, 0);

  console.log(`[sla-check] ${now.toISOString()} — ${rules.length} rules, ${breachedCount} breaches across ${conversations.length} open conversations`);

  return NextResponse.json({
    checkedAt: now,
    totalRules: rules.length,
    openConversations: conversations.length,
    breachedCount,
    results,
  });
}
