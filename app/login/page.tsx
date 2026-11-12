import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { allowedDomainsLabel } from '@/lib/auth/options';
import { getOptionalSession } from '@/lib/auth/session';
import { getPublicStats } from '@/lib/marketing/stats';
import { appBaseUrl } from '@/lib/app-url';
import { LandingPage } from '@/components/marketing/LandingPage';
import { AutoSignIn } from '@/components/marketing/AutoSignIn';

/**
 * /login shows the same landing page as "/" (with "Continue with Google" in the hero) rather
 * than redirecting signed-out visitors: sign-out, the app's guards and /login/error all link here,
 * and a page (not a redirect) keeps those flows one hop shorter. NextAuth only uses /login/error,
 * which is unchanged. Not indexed; the canonical copy is "/".
 *
 * Someone who is already signed in is sent straight into the app instead of being shown a sign-in
 * button that would run the whole Google login again. getOptionalSession treats a disabled account
 * as signed out, so a disabled person with a leftover session sees this page rather than looping
 * between here and the app's own redirect back to /login.
 *
 * /login?continue=google (where the old address's /login redirects to) starts Google sign-in by itself.
 */
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(appBaseUrl()),
    title: 'Sign in — MailFlow',
    alternates: { canonical: '/' },
    robots: { index: false, follow: true },
  };
}

export default async function LoginPage({ searchParams }: { searchParams: { continue?: string } }) {
  const session = await getOptionalSession();
  if (session) redirect('/');
  const stats = await getPublicStats();
  return (
    <>
      {searchParams.continue === 'google' && <AutoSignIn />}
      <LandingPage stats={stats} domains={allowedDomainsLabel()} />
    </>
  );
}
