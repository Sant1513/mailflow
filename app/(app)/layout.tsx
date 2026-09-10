import { redirect } from 'next/navigation';
import { getOptionalSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { AppNav } from '@/components/nav/AppNav';
import { ViewAsBanner } from '@/components/nav/ViewAsBanner';
import { Role } from '@prisma/client';
import { reviewScope } from '@/lib/permissions/reviewer';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Resolved server-side, including any §9 "view as" scope, so the banner
  // is driven by the same session every page and API route sees.
  const session = await getOptionalSession();
  if (!session) redirect('/login');

  // Badge for reviewers: how many campaigns await a decision in their scope.
  let pendingApprovals = 0;
  if (session.role === Role.SUPER_ADMIN || session.role === Role.ADMIN) {
    pendingApprovals = await prisma.campaign.count({ where: { status: 'PENDING_APPROVAL', ...(await reviewScope(session)) } });
  }

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <AppNav user={{ name: session.name, email: session.email, image: null, role: session.role }} pendingApprovals={pendingApprovals} />
      <div className="flex min-w-0 flex-1 flex-col">
        {session.viewingAs && <ViewAsBanner viewingAs={session.viewingAs} />}
        {/* Pages that want a full-height layout use h-full inside this box. */}
        <main className="min-h-0 flex-1 overflow-x-hidden bg-background lg:h-dvh lg:overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
