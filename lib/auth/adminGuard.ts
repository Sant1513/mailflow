import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';

/** Server-side gate for /admin/* pages — never rely on hiding the nav link alone (§8/§94). */
export async function requireSuperAdminPage() {
  const session = await getServerSession(authOptions);
  const user = session?.user as any;
  if (!user || user.status === 'DISABLED') redirect('/login');
  if (user.status === 'PENDING') redirect('/pending');
  if (user.role !== 'SUPER_ADMIN') redirect('/');
  return user;
}
