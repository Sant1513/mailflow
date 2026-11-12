import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { CURRENT_PRODUCT_COOKIE, isProduct } from '@/lib/products';
import { getOptionalSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { AppNav } from '@/components/nav/AppNav';
import { TopBar } from '@/components/nav/TopBar';
import { ViewAsBanner } from '@/components/nav/ViewAsBanner';
import { KeyboardShortcuts } from '@/components/nav/KeyboardShortcuts';
import { MotionProvider, PageTransition } from '@/components/motion/Motion';
import { Role } from '@prisma/client';
import { reviewScope } from '@/lib/permissions/reviewer';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Resolved server-side, including any §9 "view as" scope, so the banner
  // is driven by the same session every page and API route sees.
  const session = await getOptionalSession();
  if (!session) redirect('/login');
  if (session.status === 'PENDING') redirect('/pending');

  // Badge for reviewers: how many campaigns await a decision in their scope.
  let pendingApprovals = 0;
  if (session.role === Role.SUPER_ADMIN || session.role === Role.ADMIN) {
    pendingApprovals = await prisma.campaign.count({ where: { status: 'PENDING_APPROVAL', ...(await reviewScope(session)) } });
  }

  const lastProduct = cookies().get(CURRENT_PRODUCT_COOKIE)?.value;
  const user = { name: session.name, email: session.email, image: null, role: session.role };

  return (
    <MotionProvider>
      {/* On desktop only the page column scrolls (never the browser page behind it). */}
      <div className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row lg:overflow-hidden">
        <KeyboardShortcuts />
        <AppNav user={user} pendingApprovals={pendingApprovals} initialProduct={isProduct(lastProduct) ? lastProduct : 'mail'} />
        {/* The page column scrolls on its own (lg) so the floating sidebar and top bar stay put. */}
        <div className="flex min-w-0 flex-1 flex-col lg:h-dvh lg:overflow-y-auto" id="app-scroll">
          <TopBar user={user} />
          {session.viewingAs && (
            <div className="lg:px-3 lg:pt-3">
              <ViewAsBanner viewingAs={session.viewingAs} />
            </div>
          )}
          {/* Pages that want a full-height layout use h-full inside this box. `relative` makes this the
              containing block for absolutely positioned bits (sr-only labels, hidden file inputs) so
              they stay inside the column instead of stretching the browser page and leaving a blank
              scroll area below the content. */}
          <main className="relative min-h-0 flex-1 overflow-x-hidden">
            <PageTransition>{children}</PageTransition>
          </main>
        </div>
      </div>
    </MotionProvider>
  );
}
