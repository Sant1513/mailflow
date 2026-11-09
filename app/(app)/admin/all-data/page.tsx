import { Suspense } from 'react';
import { requireSuperAdminPage } from '@/lib/auth/adminGuard';
import { prisma } from '@/lib/db/client';
import { parsePaging } from '@/lib/api/paging';
import { UrlListPager } from '@/components/ui/UrlListPager';

/** Every dataset across every workspace, paged (?page=&pageSize=), with the total. */
export default async function AdminAllDataPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = await requireSuperAdminPage();
  const paging = parsePaging(new URLSearchParams(Object.entries(searchParams).filter((e): e is [string, string] => typeof e[1] === 'string')), { pageSize: 50 });
  const where = { workspace: { organizationId: user.organizationId } };

  const [datasets, total] = await Promise.all([
    prisma.dataset.findMany({
      where,
      include: {
        workspace: { select: { name: true } },
        owner: { select: { name: true, email: true } },
        _count: { select: { records: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: paging.skip,
      take: paging.take,
    }),
    prisma.dataset.count({ where }),
  ]);

  return (
    <div className="p-6">
      <h1 className="mb-1 font-heading text-2xl font-bold tracking-tight">All Data</h1>
      <p className="mb-4 text-sm text-muted-foreground">Every dataset across every workspace, organization-wide.</p>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[560px] text-sm">
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
                <td className="px-4 py-2">{d.owner.name ? <span title={d.owner.email}>{d.owner.name}</span> : d.owner.email}</td>
                <td className="px-4 py-2 tabular-nums">{d._count.records.toLocaleString('en-IN')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Suspense fallback={null}>
          <UrlListPager page={paging.page} pageSize={paging.pageSize} total={total} noun="datasets" className="border-t px-3" />
        </Suspense>
      </div>
    </div>
  );
}
