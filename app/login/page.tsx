import type { Metadata } from 'next';
import { allowedDomainsLabel } from '@/lib/auth/options';
import { getPublicStats } from '@/lib/marketing/stats';
import { appBaseUrl } from '@/lib/app-url';
import { LandingPage } from '@/components/marketing/LandingPage';

/**
 * /login shows the same landing page as "/" (with "Continue with Google" in the hero) rather
 * than redirecting: sign-out, the app's guards and /login/error all link here, and a page
 * (not a redirect) keeps those flows one hop shorter. NextAuth only uses /login/error, which
 * is unchanged. Not indexed; the canonical copy is "/".
 */
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(appBaseUrl()),
    title: 'Sign in — MailFlow',
    alternates: { canonical: '/' },
    robots: { index: false, follow: true },
  };
}

export default async function LoginPage() {
  const stats = await getPublicStats();
  return <LandingPage stats={stats} domains={allowedDomainsLabel()} />;
}
