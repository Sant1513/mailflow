'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';

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
      className="flex w-full items-center justify-center gap-2 rounded-md border bg-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-muted disabled:opacity-60"
    >
      {busy ? 'Connecting to Google…' : 'Continue with Google'}
    </button>
  );
}
