import { redirect } from 'next/navigation';
import { getOptionalSession } from '@/lib/auth/session';
import { AppNav } from '@/components/nav/AppNav';
import { ViewAsBanner } from '@/components/nav/ViewAsBanner';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Resolved server-side, including any §9 "view as" scope, so the banner
  // is driven by the same session every page and API route sees.
  const session = await getOptionalSession();
  if (!session) redirect('/login');

  return (
    <div className="flex min-h-screen">
      <AppNav user={{ name: session.name, email: session.email, image: null, role: session.role }} />
      <div className="flex min-w-0 flex-1 flex-col">
        {session.viewingAs && <ViewAsBanner viewingAs={session.viewingAs} />}
        <main className="flex-1 overflow-x-hidden bg-background">{children}</main>
      </div>
    </div>
  );
}
