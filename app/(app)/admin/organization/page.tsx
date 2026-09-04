import { requireSuperAdminPage } from '@/lib/auth/adminGuard';
import { prisma } from '@/lib/db/client';

export default async function AdminOrganizationPage() {
  const user = await requireSuperAdminPage();

  const [users, workspaces, contacts, datasets, campaigns] = await Promise.all([
    prisma.user.count({ where: { organizationId: user.organizationId } }),
    prisma.workspace.count({ where: { organizationId: user.organizationId } }),
    prisma.contact.count({ where: { organizationId: user.organizationId } }),
    prisma.dataset.count({ where: { workspace: { organizationId: user.organizationId } } }),
    prisma.campaign.count({ where: { organizationId: user.organizationId } }),
  ]);

  const stats = [
    { label: 'Users', value: users },
    { label: 'Workspaces', value: workspaces },
    { label: 'Contacts', value: contacts },
    { label: 'Datasets', value: datasets },
    { label: 'Campaigns', value: campaigns },
  ];

  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">Organization</h1>
      <p className="mb-4 text-sm text-muted-foreground">Masai School — organization-wide overview.</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border bg-card p-4">
            <div className="text-2xl font-semibold">{s.value}</div>
            <div className="text-xs text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Emails sent / replies / AI usage charts land in Phase 6 once campaigns and AI are wired
        up.
      </p>
    </div>
  );
}
