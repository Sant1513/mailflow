'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRenewalRequest } from '@/components/org/RequestRenewal';

/**
 * Shown instead of a page when the organisation's access has ended (everything but the Dashboard) or it has been disabled
 * (everything). Says what happened in plain words, who to contact, and offers the one action that is left: ask for an extension.
 */
export function LockedScreen({ orgName, state, title, body, contacts, canViewDashboard }: {
  orgName: string;
  state: 'EXPIRED' | 'DISABLED';
  title: string;
  body: string;
  contacts: { name: string; email: string }[];
  canViewDashboard: boolean;
}) {
  const [message, setMessage] = useState('');
  const { state: req, note, send } = useRenewalRequest();
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6" data-locked-screen={state}>
      <div className="w-full max-w-xl rounded-xl border bg-card p-6 shadow-sm">
        <div className="eyebrow mb-2">{state === 'EXPIRED' ? 'Access ended' : 'Organisation disabled'}</div>
        <h1 className="font-heading text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
        <ul className="mt-4 space-y-1 text-sm">
          <li>✓ Nothing is deleted: all your data, mailboxes and settings are kept.</li>
          <li>✓ Emails already queued are held, not lost, and carry on when {orgName} is renewed.</li>
          <li>✓ Everything comes back the moment the extension is recorded.</li>
        </ul>

        <div className="mt-5 rounded-lg border bg-muted/40 p-4">
          <div className="text-sm font-semibold">To extend, contact the MailFlow team and make the payment</div>
          {contacts.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-sm">
              {contacts.map((c) => <li key={c.email}>{c.name} · <a className="underline" href={`mailto:${c.email}?subject=${encodeURIComponent(`Renew ${orgName}`)}`}>{c.email}</a></li>)}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">Ask your organisation’s admin to contact the MailFlow team.</p>
          )}
          <label className="mt-3 block text-xs font-medium">Message (optional)
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} rows={2} placeholder="e.g. Payment made on 28 Nov, reference 12345" className="input mt-1 w-full" disabled={req === 'sent' || req === 'already'} />
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button type="button" className="btn-primary" disabled={req === 'sending' || req === 'sent' || req === 'already'} onClick={() => void send(message)}>
              {req === 'sent' ? 'Request sent ✓' : req === 'already' ? 'Already requested' : req === 'sending' ? 'Sending…' : 'Request extension'}
            </button>
            {req === 'sent' && <span className="text-xs text-muted-foreground">The MailFlow team has been told.</span>}
            {note && <span className={`text-xs ${req === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{note}</span>}
          </div>
        </div>

        {canViewDashboard && (
          <p className="mt-4 text-sm">You can still look at the <Link href="/dashboard" className="font-medium underline">Dashboard</Link>.</p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">You can sign out from the menu at the top right.</p>
      </div>
    </div>
  );
}
