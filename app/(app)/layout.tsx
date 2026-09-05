import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { AppNav } from '@/components/nav/AppNav';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect('/login');
  const user = session.user as any;

  return (
    <div className="flex min-h-screen">
      <AppNav
        user={{ name: user.name, email: user.email, image: user.image, role: user.role }}
      />
      <main className="flex-1 overflow-x-hidden bg-background">{children}</main>
    </div>
  );
}
