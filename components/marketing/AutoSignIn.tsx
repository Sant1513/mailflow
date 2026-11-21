'use client';

import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { SigningIn } from '@/components/loading/SigningIn';

/**
 * Starts "Continue with Google" by itself. Used when someone arrives from the old address
 * (mailflow-six-sooty.vercel.app/login redirects to /login?continue=google): a login at one
 * address isn't visible at another, so they have to sign in once here, and with a Google session
 * in the browser that is one click on Google's side. It starts at most once per tab, so coming
 * back from Google's page (cancelled, or an error) never loops.
 */
export function AutoSignIn() {
  // Only shown when sign-in really starts, so coming back from Google (cancelled, or an error) never leaves a loading screen behind.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem('mailflow.autoSignIn')) return;
      sessionStorage.setItem('mailflow.autoSignIn', '1');
    } catch {
      return; // no storage: don't risk a loop
    }
    setStarted(true);
    void signIn('google', { callbackUrl: '/' });
  }, []);
  return started ? <SigningIn text="MailFlow has a new address, taking you to Google…" /> : null;
}
