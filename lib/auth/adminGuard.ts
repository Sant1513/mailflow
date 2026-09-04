import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';

/** Server-side gate for /admin/* pages — never rely on hiding the nav link alone (§8/§94). */
export async function requireSuperAdminPage() {
  const session = await getServerSession(authOptions);
  const user = session?.user as any;
  if (!user) redirect('/login');
  if (user.role !== 'SUPER_ADMIN') redirect('/dashboard');
  return user;
}
