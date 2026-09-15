import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getOptionalSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import {
  approvalStats,
  campaignPerformance,
  dailySeries,
  parseDays,
  responseTimeMetrics,
  totals,
  trackingStats,
} from '@/lib/analytics/metrics';
import { ApprovalsChart, DailyAreaChart } from '@/components/analytics/Charts';
import { Suspense } from 'react';
import { DayFilter } from '@/components/dashboard/DayFilter';
import { windowStart } from '@/lib/analytics/series';

export const dynamic = 'force-dynamic';

const STATUS_BADGE: Record<string, string> = {
  COMPLETED: 'badge-success',
  RUNNING: 'badge-info',
  QUEUED: 'badge-info',
  PREPARING: 'badge-neutral',
  PAUSED: 'badge-warning',
  PARTIALLY_FAILED: 'badge-warning',
  FAILED: 'badge-danger',
  CANCELLED: 'badge-neutral',
};

function fmtDuration(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

/** §86/§140 dashboard — workspace numbers, FRT/ART, email chart, approvals, campaigns. */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { days?: string };
}) {
  const session = await getOptionalSession();
  if (!session) redirect('/login');
  const workspaceId = session.workspaceId;

  const days = parseDays(searchParams.days, 30);

  if (!workspaceId) {
    return (
      <div className="p-6">
        <h1 className="font-heading text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">No workspace is attached to your account yet. Ask an administrator.</p>
      </div>
    );
  }

  const scope = { workspaceId };
  const since = windowStart(days);

  const [t, series, batches, conversations, activity, approvals, rt, campaigns, tracking] = await Promise.all([
    totals(scope, new Date(), since),
    dailySeries(scope, days),
    prisma.batch.findMany({
      where: { campaign: { workspaceId } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        label: true,
        status: true,
        total: true,
        sentCount: true,
        failedCount: true,
        createdAt: true,
        campaign: { select: { id: true, name: true } },
      },
    }),
    prisma.conversation.findMany({
      where: { workspaceId },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      take: 5,
      select: { id: true, subject: true, recipientEmail: true, status: true, unread: true, lastMessageAt: true },
    }),
    prisma.auditLog.findMany({
      where: { organizationId: session.organizationId, actorId: session.viewingAs ? undefined : session.userId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, action: true, targetType: true, createdAt: true, actor: { select: { name: true } } },
    }),
    approvalStats(scope, days),
    responseTimeMetrics(scope, days),
    campaignPerformance(scope, 8),
    trackingStats(scope, since),
  ]);

  const replyRate = t.emailsSent > 0 ? Math.round((t.replies / t.emailsSent) * 100) : null;
  const resolutionRate =
    t.openConversations + t.resolvedConversations > 0
      ? Math.round((t.resolvedConversations / (t.openConversations + t.resolvedConversations)) * 100)
      : null;

  const primaryStats = [
    { label: 'Emails sent', value: t.emailsSent.toLocaleString('en-IN'), accent: true },
    { label: 'Replies received', value: t.replies.toLocaleString('en-IN'), accent: true },
    { label: 'Reply rate', value: replyRate !== null ? `${replyRate}%` : '—', accent: true },
    { label: 'Failed emails', value: t.emailsFailed.toLocaleString('en-IN'), warn: t.emailsFailed > 0 },
    { label: 'Pending sends', value: t.emailsPending.toLocaleString('en-IN') },
    { label: 'Unread', value: t.unread.toLocaleString('en-IN'), warn: t.unread > 0 },
    { label: 'Open conversations', value: t.openConversations.toLocaleString('en-IN') },
    { label: 'Resolution rate', value: resolutionRate !== null ? `${resolutionRate}%` : '—' },
    { label: 'Follow-ups due', value: t.followUpsDue.toLocaleString('en-IN'), warn: t.followUpsDue > 0 },
  ];

  const responseStats = [
    { label: 'First Response Time', value: fmtDuration(rt.frtMinutes), desc: 'avg time to first reply', accent: true },
    { label: 'Avg Response Time', value: fmtDuration(rt.artMinutes), desc: 'avg across all replies', accent: true },
    { label: 'Conversations replied', value: `${rt.respondedConversations}/${rt.totalConversations}`, desc: `${rt.replyRate !== null ? rt.replyRate + '% responded' : 'no data'}` },
  ];

  return (
    <div className="p-6">
      {/* Header + day filter */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">{session.viewingAs ? session.viewingAs.workspaceName : 'Workspace'}</div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">
            {session.viewingAs ? `${session.viewingAs.ownerName}'s dashboard` : `Welcome back, ${session.name.split(' ')[0]}.`}
          </h1>
        </div>
        <Suspense fallback={null}>
          <DayFilter current={days} />
        </Suspense>
      </div>

      {/* Primary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-9">
        {primaryStats.map((s) => (
          <div key={s.label} className="panel p-4">
            <div className={`font-heading text-2xl font-bold ${s.warn ? 'text-warning' : s.accent ? 'text-primary' : 'text-foreground'}`}>
              {s.value}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Email engagement */}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="panel p-4">
          <div className="font-heading text-2xl font-bold text-primary">{tracking.uniqueOpens.toLocaleString('en-IN')}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">Unique opens</div>
        </div>
        <div className="panel p-4">
          <div className="font-heading text-2xl font-bold text-primary">
            {tracking.openRate !== null ? `${tracking.openRate}%` : '—'}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">Open rate</div>
        </div>
        <div className="panel p-4">
          <div className="font-heading text-2xl font-bold text-primary">{tracking.uniqueClicks.toLocaleString('en-IN')}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">Unique clicks</div>
        </div>
        <div className="panel p-4">
          <div className="font-heading text-2xl font-bold text-primary">
            {tracking.clickRate !== null ? `${tracking.clickRate}%` : '—'}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">Click rate</div>
        </div>
        <div className="panel p-4">
          <div className={`font-heading text-2xl font-bold ${tracking.unsubscribes > 0 ? 'text-warning' : 'text-foreground'}`}>
            {tracking.unsubscribes.toLocaleString('en-IN')}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">Unsubscribes</div>
        </div>
      </div>

      {/* Response time KPIs */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {responseStats.map((s) => (
          <div key={s.label} className="panel flex items-center gap-4 p-4">
            <div>
              <div className={`font-heading text-3xl font-bold ${s.accent ? 'text-primary' : 'text-foreground'}`}>
                {s.value}
              </div>
              <div className="mt-0.5 text-sm font-medium">{s.label}</div>
              <div className="text-xs text-muted-foreground">{s.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts row */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="panel p-4 lg:col-span-2">
          <div className="mb-3 flex items-baseline justify-between">
            <div className="font-heading text-sm font-semibold">Emails sent · last {days} days</div>
            <div className="text-xs text-muted-foreground">
              {series.failurePct === null ? 'No attempts yet' : `${series.failurePct}% failure rate`}
            </div>
          </div>
          <DailyAreaChart series={series.emailsByDay} label="Sent" height={200} />
        </div>

        <div className="panel p-4">
          <div className="mb-3 font-heading text-sm font-semibold">Quick actions</div>
          <div className="grid gap-2">
            <QuickAction href="/data" label="Import data" desc="Paste, CSV or XLSX — never sends on import." />
            <QuickAction href="/templates" label="Create template" desc="Versioned, with variables and health checks." />
            <QuickAction href="/campaigns" label="Create campaign" desc="Dry run, review, approve, then send." />
            <QuickAction href="/automations" label="Create automation" desc="Condition-driven follow-ups that stop on reply." />
          </div>
        </div>
      </div>

      {/* Approvals chart */}
      <div className="mt-4">
        <div className="panel p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-heading text-sm font-semibold">Campaign approvals · last {days} days</div>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span><span className="font-semibold text-warning">{approvals.pending}</span> pending{approvals.oldestPendingHours !== null ? ` (oldest ${approvals.oldestPendingHours} h)` : ''}</span>
              <span><span className="font-semibold text-success">{approvals.approved}</span> approved</span>
              <span><span className="font-semibold text-primary">{approvals.rejected}</span> rejected</span>
              {approvals.medianWaitHours !== null && <span>median wait {approvals.medianWaitHours} h</span>}
              {(session.role === 'ADMIN' || session.role === 'SUPER_ADMIN') && <Link href="/approvals" className="text-primary hover:underline">Open approvals</Link>}
            </div>
          </div>
          <ApprovalsChart series={approvals.byDay} height={160} />
        </div>
      </div>

      {/* Campaign performance table */}
      {campaigns.length > 0 && (
        <div className="mt-4">
          <div className="panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="font-heading text-sm font-semibold">Campaign performance</div>
              <Link href="/campaigns" className="text-xs text-muted-foreground hover:text-primary">View all</Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2">Campaign</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2 text-right">Sent</th>
                    <th className="px-4 py-2 text-right">Opens</th>
                    <th className="px-4 py-2 text-right">Clicks</th>
                    <th className="px-4 py-2 text-right">Failed</th>
                    <th className="px-4 py-2 text-right">Failure %</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="px-4 py-2">
                        <Link href={`/campaigns/${c.id}`} className="font-medium hover:text-primary">{c.name}</Link>
                        <div className="text-xs text-faint">{c.workspaceName}</div>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`badge ${STATUS_BADGE[c.status] ?? 'badge-neutral'}`}>{c.status}</span>
                      </td>
                      <td className="px-4 py-2 text-right">{c.sent.toLocaleString('en-IN')}</td>
                      <td className="px-4 py-2 text-right text-muted-foreground">
                        {c.opens > 0 ? (
                          <span title={`${c.openRate ?? 0}% open rate`}>
                            {c.opens.toLocaleString('en-IN')}
                            {c.openRate !== null && <span className="ml-1 text-xs text-faint">{c.openRate}%</span>}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground">
                        {c.clicks > 0 ? (
                          <span title={`${c.clickRate ?? 0}% click rate`}>
                            {c.clicks.toLocaleString('en-IN')}
                            {c.clickRate !== null && <span className="ml-1 text-xs text-faint">{c.clickRate}%</span>}
                          </span>
                        ) : '—'}
                      </td>
                      <td className={`px-4 py-2 text-right ${c.failed > 0 ? 'text-warning' : ''}`}>{c.failed}</td>
                      <td className={`px-4 py-2 text-right ${c.failurePct !== null && c.failurePct > 5 ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                        {c.failurePct !== null ? `${c.failurePct}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Recent rows */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Recent batches" href="/batches">
          {batches.length === 0 ? (
            <Empty>No batches yet — send a campaign to see them here.</Empty>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {batches.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <Link href={`/campaigns/${b.campaign.id}`} className="block truncate font-medium hover:text-primary">
                      {b.campaign.name}
                    </Link>
                    <div className="text-xs text-faint">
                      {b.label} · {b.sentCount}/{b.total} sent{b.failedCount ? ` · ${b.failedCount} failed` : ''}
                    </div>
                  </div>
                  <span className={`badge ${STATUS_BADGE[b.status] ?? 'badge-neutral'}`}>{b.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent conversations" href="/inbox">
          {conversations.length === 0 ? (
            <Empty>No conversations yet — replies land here after Gmail sync.</Empty>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {conversations.map((c) => (
                <li key={c.id} className="px-4 py-2.5 text-sm">
                  <Link href={`/inbox/${c.id}`} className="flex items-center gap-2 hover:text-primary">
                    {c.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread" />}
                    <span className={`truncate ${c.unread ? 'font-semibold' : ''}`}>{c.subject || '(no subject)'}</span>
                  </Link>
                  <div className="text-xs text-faint">
                    {c.recipientEmail} · {c.status.replace(/_/g, ' ').toLowerCase()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent activity" href="/history">
          {activity.length === 0 ? (
            <Empty>Nothing audited yet.</Empty>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {activity.map((a) => (
                <li key={a.id} className="px-4 py-2.5 text-sm">
                  <div className="truncate">
                    <span className="font-medium">{a.action.replace(/_/g, ' ').toLowerCase()}</span>
                    {a.targetType && <span className="text-muted-foreground"> · {a.targetType}</span>}
                  </div>
                  <div className="text-xs text-faint">
                    {a.actor?.name ?? 'system'} · {a.createdAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Card({ title, href, children }: { title: string; href: string; children: React.ReactNode }) {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="font-heading text-sm font-semibold">{title}</div>
        <Link href={href} className="text-xs text-muted-foreground hover:text-primary">
          View all
        </Link>
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-sm text-muted-foreground">{children}</p>;
}

function QuickAction({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <Link href={href} className="group rounded-md border border-border-subtle bg-elevated/40 px-3 py-2.5 hover:border-faint hover:bg-elevated">
      <div className="text-sm font-medium group-hover:text-primary">{label}</div>
      <div className="text-xs text-muted-foreground">{desc}</div>
    </Link>
  );
}
