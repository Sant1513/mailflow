'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function ErrorMessage() {
  const params = useSearchParams();
  const error = params.get('error');
  const message =
    error === 'AccessDenied'
      ? 'Please sign in using your official @masaischool.com account.'
      : 'Something went wrong signing you in. Please try again.';

  return <p className="mb-6 text-sm text-muted-foreground">{message}</p>;
}

export default function LoginErrorPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm rounded-lg border bg-card p-8 text-center shadow-sm">
        <h1 className="mb-2 text-lg font-semibold text-destructive">Sign-in blocked</h1>
        <Suspense fallback={<p className="mb-6 text-sm text-muted-foreground">Loading…</p>}>
          <ErrorMessage />
        </Suspense>
        <a href="/login" className="text-sm font-medium text-primary underline">
          Back to sign in
        </a>
      </div>
    </div>
  );
}
