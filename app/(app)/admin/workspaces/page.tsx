import { requireSuperAdminPage } from '@/lib/auth/adminGuard';
import { prisma } from '@/lib/db/client';
import { ViewWorkspaceButton } from '@/components/admin/ViewWorkspaceButton';
import { Suspense } from 'react';
import { parsePaging } from '@/lib/api/paging';
import { UrlListPager } from '@/components/ui/UrlListPager';

export default async function AdminWorkspacesPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = await requireSuperAdminPage();
  const paging = parsePaging(new URLSearchParams(Object.entries(searchParams).filter((e): e is [string, string] => typeof e[1] === 'string')), { pageSize: 50 });
  const total = await prisma.workspace.count({ where: { organizationId: user.organizationId } });

  const workspaces = await prisma.workspace.findMany({
    where: { organizationId: user.organizationId },
    skip: paging.skip,
    take: paging.take,
    include: {
      owner: { select: { name: true, email: true } },
      _count: { select: { contacts: true, datasets: true, campaigns: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  return (
    <div className="p-6">
      <h1 className="mb-1 font-heading text-2xl font-bold tracking-tight">Workspaces</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Every user&apos;s operational workspace. Viewing another user&apos;s data is audited (§9).
      </p>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[640px] text-sm">
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
                  <ViewWorkspaceButton workspaceId={w.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Suspense fallback={null}>
          <UrlListPager page={paging.page} pageSize={paging.pageSize} total={total} noun="workspaces" className="border-t px-3" />
        </Suspense>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Viewing opens the workspace read-only under a &quot;VIEWING WORKSPACE AS&quot; banner; entering and exiting are both audited (§9).
      </p>
    </div>
  );
}
