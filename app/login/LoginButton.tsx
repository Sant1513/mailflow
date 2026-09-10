'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path
        fill="currentColor"
        d="M21.6 12.23c0-.68-.06-1.33-.17-1.96H12v3.71h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.75 2.98-4.32 2.98-7.27Z"
      />
      <path
        fill="currentColor"
        opacity=".8"
        d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.24-2.5c-.9.6-2.04.96-3.38.96-2.6 0-4.8-1.75-5.59-4.11H3.07v2.58A10 10 0 0 0 12 22Z"
      />
      <path
        fill="currentColor"
        opacity=".6"
        d="M6.41 13.92A6.01 6.01 0 0 1 6.1 12c0-.67.11-1.31.31-1.92V7.5H3.07A10 10 0 0 0 2 12c0 1.61.39 3.14 1.07 4.5l3.34-2.58Z"
      />
      <path
        fill="currentColor"
        opacity=".9"
        d="M12 5.97c1.47 0 2.78.5 3.82 1.5l2.86-2.86C16.95 3 14.7 2 12 2a10 10 0 0 0-8.93 5.5l3.34 2.58C7.2 7.72 9.4 5.97 12 5.97Z"
      />
    </svg>
  );
}

export function LoginButton() {
  const [busy, setBusy] = useState(false);

  return (
    <button
      onClick={() => {
        // Show progress: the server fetches Google's discovery document
        // before redirecting, so there is a real gap where the button would
        // otherwise look dead.
        setBusy(true);
        signIn('google', { callbackUrl: '/dashboard' });
      }}
      disabled={busy}
      className="btn-primary flex w-full items-center justify-center gap-2.5 !py-3 text-sm disabled:cursor-wait disabled:opacity-60"
    >
      <GoogleMark />
      {busy ? 'Connecting to Google…' : 'Continue with Google'}
    </button>
  );
}
