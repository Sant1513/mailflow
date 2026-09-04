import { requireSuperAdminPage } from '@/lib/auth/adminGuard';
import { prisma } from '@/lib/db/client';

export default async function AdminAllDataPage() {
  const user = await requireSuperAdminPage();

  const datasets = await prisma.dataset.findMany({
    where: { workspace: { organizationId: user.organizationId } },
    include: {
      workspace: { select: { name: true } },
      owner: { select: { name: true, email: true } },
      _count: { select: { records: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });

  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">All Data</h1>
      <p className="mb-4 text-sm text-muted-foreground">Every dataset across every workspace, organization-wide.</p>

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Dataset</th>
              <th className="px-4 py-2">Workspace</th>
              <th className="px-4 py-2">Owner</th>
              <th className="px-4 py-2">Records</th>
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="px-4 py-2">{d.name}</td>
                <td className="px-4 py-2">{d.workspace.name}</td>
                <td className="px-4 py-2">{d.owner.email}</td>
                <td className="px-4 py-2">{d._count.records}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
