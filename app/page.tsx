import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { DEFAULT_PRODUCT_COOKIE, PRODUCTS, isProduct } from '@/lib/products';

/**
 * Root entry point (and where sign-in lands). Signed-in users go to the
 * product they chose to start in, or to the product chooser; everyone else
 * goes to the login screen. Without this the bare domain 404s.
 */
export default async function RootPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect('/login');
  const preferred = cookies().get(DEFAULT_PRODUCT_COOKIE)?.value;
  redirect(isProduct(preferred) ? PRODUCTS[preferred].home : '/choose');
}
