'use client';

import { useEffect } from 'react';
import { signIn } from 'next-auth/react';

/**
 * Starts "Continue with Google" by itself. Used when someone arrives from the old address
 * (mailflow-six-sooty.vercel.app/login redirects to /login?continue=google): a login at one
 * address isn't visible at another, so they have to sign in once here, and with a Google session
 * in the browser that is one click on Google's side. It starts at most once per tab, so coming
 * back from Google's page (cancelled, or an error) never loops.
 */
export function AutoSignIn() {
  useEffect(() => {
    try {
      if (sessionStorage.getItem('mailflow.autoSignIn')) return;
      sessionStorage.setItem('mailflow.autoSignIn', '1');
    } catch {
      return; // no storage: don't risk a loop
    }
    void signIn('google', { callbackUrl: '/' });
  }, []);
  return (
    <div role="status" aria-live="polite" className="fixed inset-x-0 top-0 z-[60] bg-primary px-4 py-2 text-center text-sm font-medium text-white">
      MailFlow has a new address, taking you to Google to sign in…
    </div>
  );
}
