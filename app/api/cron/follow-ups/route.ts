import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { SlackClient, esc, mention } from '@/lib/slack/client';
import { appUrl } from '@/lib/campaigns/approvalEmails';

/**
 * §4.3 / §87 follow-up reminders. Runs on a schedule (vercel.json, every
 * 15 min) or by hand with the secret. Every due, incomplete follow-up that
 * has not been reminded yet gets one in-app notification for the
 * conversation's assignee (or owner) and one Slack reply in the
 * conversation's notification thread (or a channel message). `remindedAt`
 * guarantees exactly one reminder per follow-up.
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

  const due = await prisma.followUp.findMany({
    where: { completed: false, remindedAt: null, dueDate: { lte: now } },
    take: 100,
    include: {
      conversation: {
        select: {
          id: true, subject: true, recipientEmail: true, organizationId: true, workspaceId: true, assigneeId: true, ownerId: true,
          notifySlackChannelId: true, notifySlackThreadTs: true,
          contact: { select: { name: true } },
        },
      },
    },
  });

  const slack = SlackClient.fromEnv();
  const settingsCache = new Map<string, { slackChannelId: string | null; slackNotifyFollowUps: boolean } | null>();
  const results: { id: string; inApp: string; slack: string }[] = [];

  for (const f of due) {
    const c = f.conversation;
    const targetUserId = c.assigneeId ?? c.ownerId;
    const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, name: true, slackUserId: true } });
    const url = appUrl(`/inbox/${c.id}`);
    const out = { id: f.id, inApp: '', slack: '' };

    try {
      await prisma.notification.create({
        data: { workspaceId: c.workspaceId, userId: targetUserId, type: 'FOLLOW_UP_DUE', title: `Follow-up due: ${c.contact.name || c.recipientEmail}`, body: f.note || c.subject, link: `/inbox/${c.id}` },
      });
      out.inApp = 'SENT';
    } catch (err) {
      out.inApp = `FAILED: ${(err as Error).message}`;
    }

    try {
      if (!settingsCache.has(c.organizationId)) {
        const s = await prisma.integrationSettings.findUnique({ where: { organizationId: c.organizationId }, select: { slackChannelId: true, slackNotifyFollowUps: true } });
        settingsCache.set(c.organizationId, s);
      }
      const s = settingsCache.get(c.organizationId);
      const channel = c.notifySlackChannelId ?? s?.slackChannelId ?? null;
      if (!slack) out.slack = 'SKIPPED: no token';
      else if (!channel) out.slack = 'SKIPPED: no channel';
      else if (s && !s.slackNotifyFollowUps) out.slack = 'SKIPPED: off';
      else {
        const text = `:alarm_clock: ${mention(target?.slackUserId, esc(target?.name ?? 'team'))} — follow-up due for <${url}|${esc(c.subject || '(no subject)')}> with ${esc(c.contact.name || c.recipientEmail)}${f.note ? `\n> ${esc(f.note)}` : ''}`;
        const r = await slack.postMessage({ channel, text, threadTs: c.notifySlackThreadTs, broadcast: !!c.notifySlackThreadTs });
        out.slack = r.ok ? 'SENT' : `FAILED: ${r.error}`;
      }
    } catch (err) {
      out.slack = `FAILED: ${(err as Error).message}`;
    }

    await prisma.followUp.update({ where: { id: f.id }, data: { remindedAt: now } });
    results.push(out);
  }

  return NextResponse.json({ checkedAt: now, reminded: results.length, results });
}
