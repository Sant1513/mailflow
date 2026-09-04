import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';

/**
 * Root entry point. Signed-in users land on the dashboard; everyone else
 * goes to the login screen. Without this the bare domain 404s.
 */
export default async function RootPage() {
  const session = await getServerSession(authOptions);
  redirect(session?.user ? '/dashboard' : '/login');
}
