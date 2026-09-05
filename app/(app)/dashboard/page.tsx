import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getOptionalSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { dailySeries, totals } from '@/lib/analytics/metrics';
import { DailyAreaChart } from '@/components/analytics/Charts';

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

/** §86 dashboard — live workspace numbers, recent batches/conversations/activity, quick actions. */
export default async function DashboardPage() {
  const session = await getOptionalSession();
  if (!session) redirect('/login');
  const workspaceId = session.workspaceId;

  if (!workspaceId) {
    return (
      <div className="p-6">
        <h1 className="font-heading text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">No workspace is attached to your account yet. Ask an administrator.</p>
      </div>
    );
  }

  const scope = { workspaceId };
  const [t, series, batches, conversations, activity] = await Promise.all([
    totals(scope),
    dailySeries(scope, 30),
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
  ]);

  const stats = [
    { label: 'Emails sent', value: t.emailsSent, accent: true },
    { label: 'Pending', value: t.emailsPending },
    { label: 'Failed', value: t.emailsFailed, warn: t.emailsFailed > 0 },
    { label: 'Replies', value: t.replies, accent: true },
    { label: 'Unread', value: t.unread, warn: t.unread > 0 },
    { label: 'Open conversations', value: t.openConversations },
    { label: 'Follow-ups due', value: t.followUpsDue, warn: t.followUpsDue > 0 },
  ];

  return (
    <div className="p-6">
      <div className="mb-6">
        <div className="eyebrow mb-2">{session.viewingAs ? session.viewingAs.workspaceName : 'Workspace'}</div>
        <h1 className="font-heading text-2xl font-bold tracking-tight">
          {session.viewingAs ? `${session.viewingAs.ownerName}'s dashboard` : `Welcome back, ${session.name.split(' ')[0]}.`}
        </h1>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {stats.map((s) => (
          <div key={s.label} className="panel p-4">
            <div
              className={`font-heading text-2xl font-bold ${
                s.warn ? 'text-warning' : s.accent ? 'text-primary' : 'text-foreground'
              }`}
            >
              {s.value.toLocaleString('en-IN')}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="panel p-4 lg:col-span-2">
          <div className="mb-3 flex items-baseline justify-between">
            <div className="font-heading text-sm font-semibold">Emails sent · last 30 days</div>
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
