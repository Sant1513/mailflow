import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions, allowedDomainsLabel } from '@/lib/auth/options';
import { DEFAULT_PRODUCT_COOKIE, PRODUCTS, isProduct } from '@/lib/products';
import { appBaseUrl } from '@/lib/app-url';
import { getPublicStats } from '@/lib/marketing/stats';
import { LandingPage } from '@/components/marketing/LandingPage';

const TITLE = 'MailFlow — every email to every batch, sent from your Gmail';
const DESCRIPTION =
  'Campaigns, a shared inbox and e-signatures for the Masai team: personalised bulk email from your own Gmail with dry runs and approvals, replies threaded back to the record, and documents signed at scale.';

export function generateMetadata(): Metadata {
  const base = appBaseUrl();
  return {
    metadataBase: new URL(base),
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: '/' },
    openGraph: { type: 'website', url: '/', siteName: 'MailFlow', title: TITLE, description: DESCRIPTION, locale: 'en_IN' },
    twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
    robots: { index: true, follow: true },
  };
}

/**
 * Root entry point (and where sign-in lands). Signed-in users go to the product they chose to
 * start in, or to the product chooser; everyone else sees the public landing page, which has
 * "Continue with Google" on it.
 */
export default async function RootPage() {
  const session = await getServerSession(authOptions);
  if (session?.user) {
    const preferred = cookies().get(DEFAULT_PRODUCT_COOKIE)?.value;
    redirect(isProduct(preferred) ? PRODUCTS[preferred].home : '/choose');
  }
  const stats = await getPublicStats();
  return <LandingPage stats={stats} domains={allowedDomainsLabel()} />;
}
