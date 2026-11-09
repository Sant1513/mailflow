import Link from 'next/link';
import { Avatar } from '@/components/ui/Avatar';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getOptionalSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import {
  approvalStats,
  campaignPerformance,
  changePct,
  dailySeries,
  parseDays,
  periodCounts,
  responseTimeMetrics,
  totals,
  trackingStats,
} from '@/lib/analytics/metrics';
import { ApprovalsChart } from '@/components/analytics/Charts';
import { DayFilter } from '@/components/dashboard/DayFilter';
import { BarTrend, Donut, Greeting, HeroCard, QuickAction, StatCard } from '@/components/dashboard/Widgets';
import { Reveal, Stagger, StaggerItem } from '@/components/motion/Motion';
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

const n = (v: number) => v.toLocaleString('en-IN');

/** §86/§140 dashboard — workspace numbers, FRT/ART, email chart, approvals, campaigns. */
export default async function DashboardPage({ searchParams }: { searchParams: { days?: string } }) {
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
  const before = new Date(since.getTime() - (Date.now() - since.getTime()));

  const [t, prev, series, batches, conversations, activity, approvals, rt, campaigns, tracking] = await Promise.all([
    totals(scope, new Date(), since),
    periodCounts(scope, before, since),
    dailySeries(scope, days),
    prisma.batch.findMany({
      where: { campaign: { workspaceId } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, label: true, status: true, total: true, sentCount: true, failedCount: true, createdAt: true, campaign: { select: { id: true, name: true } } },
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
  const prevReplyRate = prev.emailsSent > 0 ? Math.round((prev.replies / prev.emailsSent) * 100) : null;
  const resolutionRate =
    t.openConversations + t.resolvedConversations > 0 ? Math.round((t.resolvedConversations / (t.openConversations + t.resolvedConversations)) * 100) : null;
  const firstName = session.viewingAs ? session.viewingAs.ownerName : session.name.split(' ')[0] ?? session.name;
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
  const todo = [t.unread ? `${n(t.unread)} unread repl${t.unread === 1 ? 'y' : 'ies'}` : null, t.followUpsDue ? `${n(t.followUpsDue)} follow-up${t.followUpsDue === 1 ? '' : 's'} due` : null].filter(Boolean);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {session.viewingAs && <div className="eyebrow mb-2">{session.viewingAs.workspaceName}</div>}
          {session.viewingAs ? <h1 className="font-heading text-[26px] font-bold tracking-tight sm:text-3xl">{firstName}&apos;s dashboard</h1> : <Greeting name={firstName} />}
          <p className="mt-1 text-sm text-faint">
            {today}
            {todo.length ? ` · ${todo.join(' · ')}` : ' · stay on top of sends, replies and approvals'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Suspense fallback={null}>
            <DayFilter current={days} />
          </Suspense>
          <Link href="/history" className="btn-secondary !py-1.5 text-sm">Activity log</Link>
          <Link href="/campaigns" className="btn-primary !py-1.5 text-sm">+ New campaign</Link>
        </div>
      </div>

      {/* Row 1: highlight card · four headline numbers · email outcomes */}
      <Stagger className="grid gap-4 lg:grid-cols-12">
        <StaggerItem className="lg:col-span-4">
          <HeroCard
            label={`Campaign & Quick Send emails · last ${days} days`}
            value={n(t.emailsSent)}
            pct={changePct(t.emailsSent, prev.emailsSent)}
            rows={[
              { label: 'Replies', value: n(t.replies) },
              { label: 'Reply rate', value: replyRate !== null ? `${replyRate}%` : '—' },
            ]}
            actions={[
              { href: '/quick-send', label: 'Quick Send', icon: 'zap' },
              { href: '/inbox', label: 'Inbox', icon: 'inbox' },
            ]}
          />
        </StaggerItem>
        <StaggerItem className="grid grid-cols-2 gap-4 lg:col-span-4" lift={false}>
          <StatCard icon="reply" label="Replies received" value={n(t.replies)} pct={changePct(t.replies, prev.replies)} note="vs the period before" href="/inbox" />
          <StatCard icon="percent" label="Reply rate" value={replyRate !== null ? `${replyRate}%` : '—'} pct={replyRate !== null && prevReplyRate !== null ? replyRate - prevReplyRate : undefined} note="replies per campaign / Quick Send email (Recruiter Bulk Send is under Recruiter Bulk Send and Organization)" />
          <StatCard icon="eye" label="Unique opens" value={n(tracking.uniqueOpens)} note={tracking.openRate !== null ? `${tracking.openRate}% open rate` : 'no tracked sends yet'} />
          <StatCard icon="click" label="Unique clicks" value={n(tracking.uniqueClicks)} note={tracking.clickRate !== null ? `${tracking.clickRate}% click rate` : 'no tracked links yet'} />
        </StaggerItem>
        <StaggerItem className="lg:col-span-4">
          <div className="panel h-full p-5">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <div>
                <div className="font-heading text-sm font-semibold text-foreground">Email outcomes</div>
                <div className="text-xs text-faint">Last {days} days, plus what&apos;s queued now</div>
              </div>
              <Link href="/batches" className="text-xs text-faint hover:text-foreground">Batches</Link>
            </div>
            <Donut
              centerLabel="emails"
              slices={[
                { label: 'Sent', value: t.emailsSent, color: 'hsl(var(--success))' },
                { label: 'Failed', value: t.emailsFailed, color: 'hsl(var(--destructive))' },
                { label: 'Queued', value: t.emailsPending, color: 'hsl(var(--info))' },
                { label: 'Replied', value: t.replies, color: 'hsl(var(--accent-to))' },
              ]}
            />
          </div>
        </StaggerItem>
      </Stagger>

      {/* Row 2: sending trend · quick actions */}
      <Reveal className="grid gap-4 lg:grid-cols-12">
        <div className="panel p-5 lg:col-span-8">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="font-heading text-sm font-semibold text-foreground">Campaign & Quick Send emails</div>
              <div className="text-xs text-faint">
                {n(t.emailsSent)} in the last {days} days{series.emailsByDay.length > 14 ? ', by week' : ', by day'}
                {series.failurePct === null ? '' : ` · ${series.failurePct}% failure rate`}
              </div>
            </div>
            <Suspense fallback={null}>
              <DayFilter current={days} pillId="day-filter-chart" />
            </Suspense>
          </div>
          <BarTrend points={series.emailsByDay} height={230} />
        </div>
        <div className="panel p-5 lg:col-span-4">
          <div className="mb-3 font-heading text-sm font-semibold text-foreground">Quick actions</div>
          <div className="grid gap-2">
            <QuickAction href="/data" icon="database" label="Import data" desc="Paste, CSV or XLSX — never sends on import." />
            <QuickAction href="/templates" icon="pen" label="Create template" desc="Versioned, with variables and health checks." />
            <QuickAction href="/campaigns" icon="megaphone" label="Create campaign" desc="Dry run, review, approve, then send." />
            <QuickAction href="/automations" icon="workflow" label="Create automation" desc="Condition-driven follow-ups that stop on reply." />
          </div>
        </div>
      </Reveal>

      {/* Row 3: every other number */}
      <Stagger className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <StaggerItem><StatCard icon="alert" label="Failed emails" value={n(t.emailsFailed)} tone={t.emailsFailed > 0 ? 'warn' : undefined} note={`last ${days} days`} href="/batches" /></StaggerItem>
        <StaggerItem><StatCard icon="hourglass" label="Pending sends" value={n(t.emailsPending)} note="queued or sending" /></StaggerItem>
        <StaggerItem><StatCard icon="inbox" label="Unread" value={n(t.unread)} tone={t.unread > 0 ? 'warn' : undefined} note="conversations" href="/inbox?filter=unread" /></StaggerItem>
        <StaggerItem><StatCard icon="mail" label="Open conversations" value={n(t.openConversations)} note="open or waiting" href="/inbox" /></StaggerItem>
        <StaggerItem><StatCard icon="check" label="Resolution rate" value={resolutionRate !== null ? `${resolutionRate}%` : '—'} tone="good" note="resolved of all" /></StaggerItem>
        <StaggerItem><StatCard icon="bell" label="Follow-ups due" value={n(t.followUpsDue)} tone={t.followUpsDue > 0 ? 'warn' : undefined} note="due now" /></StaggerItem>
        <StaggerItem><StatCard icon="timer" label="First response" value={fmtDuration(rt.frtMinutes)} note="avg time to first reply" /></StaggerItem>
        <StaggerItem><StatCard icon="clock" label="Avg response" value={fmtDuration(rt.artMinutes)} note="avg across all replies" /></StaggerItem>
        <StaggerItem><StatCard icon="reply" label="Conversations replied" value={`${rt.respondedConversations}/${rt.totalConversations}`} note={rt.replyRate !== null ? `${rt.replyRate}% responded` : 'no data'} /></StaggerItem>
        <StaggerItem><StatCard icon="eye" label="Open rate" value={tracking.openRate !== null ? `${tracking.openRate}%` : '—'} note="of tracked emails" /></StaggerItem>
        <StaggerItem><StatCard icon="click" label="Click rate" value={tracking.clickRate !== null ? `${tracking.clickRate}%` : '—'} note="of tracked emails" /></StaggerItem>
        <StaggerItem><StatCard icon="unsub" label="Unsubscribes" value={n(tracking.unsubscribes)} tone={tracking.unsubscribes > 0 ? 'warn' : undefined} note={`last ${days} days`} href="/suppressions" /></StaggerItem>
      </Stagger>

      {/* Approvals */}
      <Reveal>
        <div className="panel p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-heading text-sm font-semibold text-foreground">Campaign approvals · last {days} days</div>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span><span className="font-semibold text-warning">{approvals.pending}</span> pending{approvals.oldestPendingHours !== null ? ` (oldest ${approvals.oldestPendingHours} h)` : ''}</span>
              <span><span className="font-semibold text-success">{approvals.approved}</span> approved</span>
              <span><span className="font-semibold text-destructive">{approvals.rejected}</span> rejected</span>
              {approvals.medianWaitHours !== null && <span>median wait {approvals.medianWaitHours} h</span>}
              {(session.role === 'ADMIN' || session.role === 'SUPER_ADMIN') && <Link href="/approvals" className="font-medium text-foreground hover:underline">Open approvals</Link>}
            </div>
          </div>
          <ApprovalsChart series={approvals.byDay} height={160} />
        </div>
      </Reveal>

      {/* Campaign performance */}
      {campaigns.length > 0 && (
        <Reveal>
          <div className="panel overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4">
              <div className="font-heading text-sm font-semibold text-foreground">Campaign performance</div>
              <Link href="/campaigns" className="text-xs text-faint hover:text-foreground">View all</Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wide text-faint">
                  <tr className="border-y border-border-subtle">
                    <th className="px-5 py-2 font-medium">Campaign</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Sent</th>
                    <th className="px-4 py-2 text-right font-medium">Opens</th>
                    <th className="px-4 py-2 text-right font-medium">Clicks</th>
                    <th className="px-4 py-2 text-right font-medium">Failed</th>
                    <th className="px-5 py-2 text-right font-medium">Failure %</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="border-b border-border-subtle transition-colors last:border-0 hover:bg-elevated/60">
                      <td className="px-5 py-2.5">
                        <Link href={`/campaigns/${c.id}`} className="font-medium text-foreground hover:underline">{c.name}</Link>
                        <div className="text-xs text-faint">{c.workspaceName}</div>
                      </td>
                      <td className="px-4 py-2.5"><span className={`badge rounded-full ${STATUS_BADGE[c.status] ?? 'badge-neutral'}`}>{c.status.replace(/_/g, ' ').toLowerCase()}</span></td>
                      <td className="px-4 py-2.5 text-right">{n(c.sent)}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {c.opens > 0 ? <span title={`${c.openRate ?? 0}% open rate`}>{n(c.opens)}{c.openRate !== null && <span className="ml-1 text-xs text-faint">{c.openRate}%</span>}</span> : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {c.clicks > 0 ? <span title={`${c.clickRate ?? 0}% click rate`}>{n(c.clicks)}{c.clickRate !== null && <span className="ml-1 text-xs text-faint">{c.clickRate}%</span>}</span> : '—'}
                      </td>
                      <td className={`px-4 py-2.5 text-right ${c.failed > 0 ? 'text-warning' : ''}`}>{c.failed}</td>
                      <td className={`px-5 py-2.5 text-right ${c.failurePct !== null && c.failurePct > 5 ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>{c.failurePct !== null ? `${c.failurePct}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Reveal>
      )}

      {/* Recent */}
      <Stagger className="grid gap-4 lg:grid-cols-3">
        <StaggerItem lift={false}>
          <Card title="Recent batches" href="/batches">
            {batches.length === 0 ? (
              <Empty>No batches yet — send a campaign to see them here.</Empty>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {batches.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                    <div className="min-w-0">
                      <Link href={`/campaigns/${b.campaign.id}`} className="block truncate font-medium text-foreground hover:underline">{b.campaign.name}</Link>
                      <div className="text-xs text-faint">{b.label} · {b.sentCount}/{b.total} sent{b.failedCount ? ` · ${b.failedCount} failed` : ''}</div>
                    </div>
                    <span className={`badge rounded-full ${STATUS_BADGE[b.status] ?? 'badge-neutral'}`}>{b.status.replace(/_/g, ' ').toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </StaggerItem>
        <StaggerItem lift={false}>
          <Card title="Recent conversations" href="/inbox">
            {conversations.length === 0 ? (
              <Empty>No conversations yet — replies land here after Gmail sync.</Empty>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {conversations.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <Avatar email={c.recipientEmail} size={30} />
                    <div className="min-w-0 flex-1">
                    <Link href={`/inbox/${c.id}`} className="flex items-center gap-2 text-foreground hover:underline">
                      {c.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-gradient-to-br from-accent-from to-accent-to" aria-label="unread" />}
                      <span className={`truncate ${c.unread ? 'font-semibold' : ''}`}>{c.subject || '(no subject)'}</span>
                    </Link>
                    <div className="truncate text-xs text-faint">{c.recipientEmail} · {c.status.replace(/_/g, ' ').toLowerCase()}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </StaggerItem>
        <StaggerItem lift={false}>
          <Card title="Recent activity" href="/history">
            {activity.length === 0 ? (
              <Empty>Nothing audited yet.</Empty>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {activity.map((a) => (
                  <li key={a.id} className="px-5 py-2.5 text-sm">
                    <div className="truncate">
                      <span className="font-medium text-foreground">{a.action.replace(/_/g, ' ').toLowerCase()}</span>
                      {a.targetType && <span className="text-muted-foreground"> · {a.targetType}</span>}
                    </div>
                    <div className="text-xs text-faint">{a.actor?.name ?? 'system'} · {a.createdAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </StaggerItem>
      </Stagger>
    </div>
  );
}

function Card({ title, href, children }: { title: string; href: string; children: React.ReactNode }) {
  return (
    <div className="panel h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="font-heading text-sm font-semibold text-foreground">{title}</div>
        <Link href={href} className="text-xs text-faint hover:text-foreground">View all</Link>
      </div>
      <div className="border-t border-border-subtle">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-6 text-sm text-muted-foreground">{children}</p>;
}
