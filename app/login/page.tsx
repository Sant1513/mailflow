'use client';

import { signIn } from 'next-auth/react';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm rounded-lg border bg-card p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">MailFlow</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Internal communication platform for Masai School staff.
        </p>
        <button
          onClick={() => signIn('google', { callbackUrl: '/dashboard' })}
          className="flex w-full items-center justify-center gap-2 rounded-md border bg-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-muted"
        >
          Continue with Google
        </button>
        <p className="mt-4 text-xs text-muted-foreground">
          Only @masaischool.com accounts can sign in.
        </p>
      </div>
    </div>
  );
}
