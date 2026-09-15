'use client';

import { signOut } from 'next-auth/react';

export function PendingSignOut() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: '/login' })}
      className="mt-8 text-xs text-muted-foreground underline hover:text-foreground"
    >
      Sign out and use a different account
    </button>
  );
}
