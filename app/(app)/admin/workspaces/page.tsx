import { requireSuperAdminPage } from '@/lib/auth/adminGuard';
import { prisma } from '@/lib/db/client';
import Link from 'next/link';

export default async function AdminWorkspacesPage() {
  const user = await requireSuperAdminPage();

  const workspaces = await prisma.workspace.findMany({
    where: { organizationId: user.organizationId },
    include: {
      owner: { select: { name: true, email: true } },
      _count: { select: { contacts: true, datasets: true, campaigns: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">Workspaces</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Every user&apos;s operational workspace. Viewing another user&apos;s data is audited (§9).
      </p>

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Workspace</th>
              <th className="px-4 py-2">Owner</th>
              <th className="px-4 py-2">Datasets</th>
              <th className="px-4 py-2">Contacts</th>
              <th className="px-4 py-2">Campaigns</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {workspaces.map((w) => (
              <tr key={w.id} className="border-t">
                <td className="px-4 py-2">{w.name}</td>
                <td className="px-4 py-2">{w.owner.name} ({w.owner.email})</td>
                <td className="px-4 py-2">{w._count.datasets}</td>
                <td className="px-4 py-2">{w._count.contacts}</td>
                <td className="px-4 py-2">{w._count.campaigns}</td>
                <td className="px-4 py-2">
                  <Link href={`/data?workspaceId=${w.id}`} className="text-xs text-primary hover:underline">
                    View Workspace
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        The &quot;VIEWING WORKSPACE AS …&quot; banner + Exit View (§9) is a Phase 6 UI polish item; the
        underlying access check and audit logging are already enforced server-side.
      </p>
    </div>
  );
}
