import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { prisma } from '@/lib/db/client';

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const user = session!.user as any;
  const workspaceId = user.workspaceId as string | null;

  const [datasetCount, contactCount, recordCount, unreadConversations] = workspaceId
    ? await Promise.all([
        prisma.dataset.count({ where: { workspaceId } }),
        prisma.contact.count({ where: { workspaceId } }),
        prisma.record.count({ where: { dataset: { workspaceId } } }),
        prisma.conversation.count({ where: { workspaceId, unread: true } }),
      ])
    : [0, 0, 0, 0];

  const stats = [
    { label: 'Datasets', value: datasetCount },
    { label: 'Contacts', value: contactCount },
    { label: 'Records', value: recordCount },
    { label: 'Unread replies', value: unreadConversations },
    { label: 'Emails sent', value: 0 },
    { label: 'Open conversations', value: 0 },
  ];

  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">Dashboard</h1>
      <p className="mb-6 text-sm text-muted-foreground">Welcome back, {user.name}.</p>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border bg-card p-4">
            <div className="text-2xl font-semibold">{s.value}</div>
            <div className="text-xs text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <QuickAction href="/data" label="Import data" desc="Paste, CSV or XLSX &mdash; never sends email on import." />
        <QuickAction href="/templates" label="Create template" desc="Coming in Phase 2." />
        <QuickAction href="/campaigns" label="Create campaign" desc="Coming in Phase 3." />
        <QuickAction href="/automations" label="Create automation" desc="Coming in Phase 4." />
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        Emails sent / replies / batches are wired up once Gmail sending (Phase 3) and inbound
        sync (Phase 5) land — see <code>PHASE_STATUS.md</code> for what&apos;s real today.
      </p>
    </div>
  );
}

function QuickAction({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <a href={href} className="rounded-lg border bg-card p-4 hover:bg-elevated">
      <div className="text-sm font-medium">{label}</div>
      <div className="text-xs text-muted-foreground">{desc}</div>
    </a>
  );
}
