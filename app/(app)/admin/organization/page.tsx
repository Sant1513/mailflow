import Link from 'next/link';
import { requireSuperAdminPage } from '@/lib/auth/adminGuard';
import { prisma } from '@/lib/db/client';
import {
  campaignPerformance,
  dailySeries,
  orgCounts,
  parseDays,
  totals,
  userActivity,
} from '@/lib/analytics/metrics';
import { DailyAreaChart, FailureRateChart } from '@/components/analytics/Charts';
import { ViewWorkspaceButton } from '@/components/admin/ViewWorkspaceButton';

export const dynamic = 'force-dynamic';

const PERIODS = [7, 30, 90];

/** §127 Super Admin analytics. Every number is a live count — see lib/analytics/metrics.ts. */
export default async function AdminOrganizationPage({
  searchParams,
}: {
  searchParams: { days?: string };
}) {
  const user = await requireSuperAdminPage();
  const organizationId = user.organizationId as string;
  const days = parseDays(searchParams.days);
  const scope = { organizationId };

  const [org, counts, t, series, campaigns, users] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
    orgCounts(organizationId, days),
    totals(scope),
    dailySeries(scope, days),
    campaignPerformance(scope, 10),
    userActivity(organizationId, days),
  ]);

  const stats = [
    { label: 'Users', value: counts.users },
    { label: `Active (${days}d)`, value: counts.activeUsers },
    { label: 'Workspaces', value: counts.workspaces },
    { label: 'Contacts', value: counts.contacts },
    { label: 'Datasets', value: counts.datasets },
    { label: 'Campaigns', value: counts.campaigns },
    { label: 'Emails sent', value: t.emailsSent, accent: true },
    { label: 'Failed', value: t.emailsFailed, warn: t.emailsFailed > 0 },
    { label: 'Replies', value: t.replies, accent: true },
    { label: 'Open conversations', value: t.openConversations },
    { label: 'Resolved', value: t.resolvedConversations },
    { label: `AI calls (${days}d)`, value: counts.aiCalls },
  ];

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">Super Admin</div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">Organization</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {org?.name ?? 'Organization'} — every workspace, every mailbox, live.
          </p>
        </div>
        <PeriodPicker days={days} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
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

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <ChartCard title="Emails by day" hint={`${series.emailsByDay.reduce((a, p) => a + p.value, 0)} sent in ${days} days`}>
          <DailyAreaChart series={series.emailsByDay} label="Sent" />
        </ChartCard>
        <ChartCard title="Replies by day" hint={`${series.repliesByDay.reduce((a, p) => a + p.value, 0)} human replies in ${days} days`}>
          <DailyAreaChart series={series.repliesByDay} label="Replies" color="info" />
        </ChartCard>
        <ChartCard
          title="Failure rate"
          hint={series.failurePct === null ? 'Nothing attempted in this window' : `${series.failurePct}% of attempts failed`}
        >
          <FailureRateChart series={series.failureByDay} />
        </ChartCard>
        <div className="panel overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <div className="font-heading text-sm font-semibold">Campaign performance</div>
            <div className="text-xs text-muted-foreground">Most recently active, all workspaces</div>
          </div>
          {campaigns.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No campaigns have been sent yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2">Campaign</th>
                    <th className="px-4 py-2 text-right">Sent</th>
                    <th className="px-4 py-2 text-right">Failed</th>
                    <th className="px-4 py-2 text-right">Skipped</th>
                    <th className="px-4 py-2 text-right">Fail %</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="border-t border-border-subtle">
                      <td className="px-4 py-2">
                        <Link href={`/campaigns/${c.id}`} className="font-medium hover:text-primary">
                          {c.name}
                        </Link>
                        <div className="text-xs text-faint">
                          {c.workspaceName} · {c.status}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.sent}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${c.failed ? 'text-warning' : ''}`}>{c.failed}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.skipped}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.failurePct === null ? '—' : `${c.failurePct}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="panel mt-4 overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <div className="font-heading text-sm font-semibold">User activity</div>
          <div className="text-xs text-muted-foreground">Audited actions and emails sent in the last {days} days</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2">User</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Last login</th>
                <th className="px-4 py-2 text-right">Actions</th>
                <th className="px-4 py-2 text-right">Emails sent</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <UserRow key={u.id} user={u} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PeriodPicker({ days }: { days: number }) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-border bg-card p-1">
      {PERIODS.map((p) => (
        <Link
          key={p}
          href={`?days=${p}`}
          className={`rounded-full px-3 py-1 text-xs font-medium transition ${
            p === days ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {p}d
        </Link>
      ))}
    </div>
  );
}

function ChartCard({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="font-heading text-sm font-semibold">{title}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      {children}
    </div>
  );
}

async function UserRow({
  user,
}: {
  user: { id: string; name: string; email: string; role: string; status: string; lastLoginAt: Date | null; actions: number; emailsSent: number };
}) {
  const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id }, select: { id: true } });
  return (
    <tr className="border-t border-border-subtle">
      <td className="px-4 py-2">
        <div className="font-medium">{user.name}</div>
        <div className="text-xs text-faint">{user.email}</div>
      </td>
      <td className="px-4 py-2">
        <span className={`badge ${user.status === 'ACTIVE' ? 'badge-neutral' : 'badge-danger'}`}>{user.role}</span>
      </td>
      <td className="px-4 py-2 text-muted-foreground">
        {user.lastLoginAt ? user.lastLoginAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never'}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">{user.actions}</td>
      <td className="px-4 py-2 text-right tabular-nums">{user.emailsSent}</td>
      <td className="px-4 py-2 text-right">{workspace && <ViewWorkspaceButton workspaceId={workspace.id} />}</td>
    </tr>
  );
}
