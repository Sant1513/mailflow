'use client';

import { useState } from 'react';

export default function UnsubscribeClient({ token, email }: { token: string; email: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');

  async function confirm() {
    setState('loading');
    const res = await fetch('/api/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    setState(res.ok ? 'done' : 'error');
  }

  if (state === 'done') {
    return (
      <div className="rounded-md bg-success/10 p-4 text-sm text-success">
        <div className="font-medium">You have been unsubscribed.</div>
        <div className="mt-1 text-success/80">
          {email} will no longer receive emails from this workspace.
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <p className="text-sm text-destructive">
        Something went wrong. Please try again or contact us directly.
      </p>
    );
  }

  return (
    <button
      onClick={confirm}
      disabled={state === 'loading'}
      className="btn-primary w-full"
    >
      {state === 'loading' ? 'Unsubscribing…' : 'Confirm unsubscribe'}
    </button>
  );
}
