'use client';

import { useState } from 'react';

/** Sends the "please renew / extend" request to the Super Admins (one per organisation every 12 hours). */
export function useRenewalRequest() {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'already' | 'error'>('idle');
  const [note, setNote] = useState<string | null>(null);
  async function send(message?: string) {
    setState('sending');
    try {
      const res = await fetch('/api/org/request-extension', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: message?.trim() || undefined }) });
      const j = await res.json().catch(() => ({}));
      if (res.ok) { setState('sent'); setNote(null); }
      else if (res.status === 429) { setState('already'); setNote(j?.error ?? null); }
      else { setState('error'); setNote(j?.error ?? 'Could not send the request.'); }
    } catch {
      setState('error');
      setNote('Could not send the request. Check your connection and try again.');
    }
  }
  return { state, note, send };
}
