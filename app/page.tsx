import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions, allowedDomainsLabel } from '@/lib/auth/options';
import { DEFAULT_PRODUCT_COOKIE, PRODUCTS, isProduct } from '@/lib/products';
import { appBaseUrl } from '@/lib/app-url';
import { getPublicStats } from '@/lib/marketing/stats';
import { LandingPage } from '@/components/marketing/LandingPage';

const TITLE = 'MailFlow by Masai — Email campaigns, shared inbox & e-signatures from your Gmail';
const DESCRIPTION =
  'MailFlow by Masai is the email campaign, shared inbox and e-signature platform built at Masai School for @masaischool.com and @neevlabs.ai teams: personalised bulk email from your own Gmail with dry runs and approvals, every reply threaded back to the record, and documents signed at scale.';
const CREATOR = 'Abhishesh Kumar';

export function generateMetadata(): Metadata {
  const base = appBaseUrl();
  // Google Search Console's HTML-tag verification for https://mailflowbymasai.vercel.app (the
  // token is public by design; GOOGLE_SITE_VERIFICATION overrides it). Keep it: removing the tag
  // un-verifies the property.
  const google = process.env.GOOGLE_SITE_VERIFICATION?.trim() || 'gfozl0obk5BdtdSw-qNKM6eOc5EmpEgsOy3DlsJQnyk';
  return {
    metadataBase: new URL(base),
    title: TITLE,
    description: DESCRIPTION,
    applicationName: 'MailFlow by Masai',
    keywords: ['MailFlow', 'MailFlow by Masai', 'Masai School', 'Masai', 'Neev Labs', 'email campaigns', 'Gmail bulk email', 'shared inbox', 'e-signature', 'recruiter outreach', 'placement emails'],
    authors: [{ name: CREATOR }],
    creator: CREATOR,
    publisher: 'Masai School',
    alternates: { canonical: '/' },
    openGraph: { type: 'website', url: '/', siteName: 'MailFlow by Masai', title: TITLE, description: DESCRIPTION, locale: 'en_IN' },
    twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 } },
    ...(google ? { verification: { google } } : {}),
  };
}

/** Structured data (schema.org): what MailFlow is, who publishes it and who built it. */
function jsonLd(base: string) {
  const org = { '@type': 'Organization', '@id': 'https://www.masaischool.com/#organization', name: 'Masai School', url: 'https://www.masaischool.com' };
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${base}/#website`, url: `${base}/`, name: 'MailFlow by Masai', alternateName: 'MailFlow', publisher: { '@id': org['@id'] }, inLanguage: 'en-IN' },
      {
        '@type': 'SoftwareApplication',
        '@id': `${base}/#app`,
        name: 'MailFlow by Masai',
        alternateName: 'MailFlow',
        url: `${base}/`,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'Email campaigns, shared inbox and e-signature',
        operatingSystem: 'Web',
        description: DESCRIPTION,
        featureList: [
          'Personalised bulk email from your own Gmail',
          'Dry runs and approvals before sending',
          'Recruiter Bulk Send',
          'Shared inbox with AI triage',
          'Automations and two-way Google Sheets sync',
          'Bulk e-signature with signing order',
          'Daily and weekly reports in email and Slack',
        ],
        author: { '@type': 'Person', name: CREATOR, affiliation: { '@id': org['@id'] } },
        creator: { '@type': 'Person', name: CREATOR },
        publisher: { '@id': org['@id'] },
      },
      org,
    ],
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
  // "<" escaped so the JSON can never close the script tag.
  const ld = JSON.stringify(jsonLd(appBaseUrl())).replace(/</g, '\\u003c');
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ld }} />
      <LandingPage stats={stats} domains={allowedDomainsLabel()} />
    </>
  );
}
