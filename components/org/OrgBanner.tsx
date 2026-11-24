'use client';

import { useEffect, useState } from 'react';
import { useRenewalRequest } from '@/components/org/RequestRenewal';

const TONE = {
  info: 'border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-100',
  warning: 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-100',
  urgent: 'border-red-400 bg-red-50 text-red-950 dark:border-red-700 dark:bg-red-950/60 dark:text-red-100',
} as const;

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * The renewal banner every page shows while the organisation is about to end (or has ended but is in its grace days, or is
 * Dashboard-only). Only the calmest level (30 to 15 days left) can be dismissed, and only for the day; warnings and urgent
 * notices stay until it is renewed.
 */
export function OrgBanner({ orgId, level, title, body, daysLeft }: { orgId: string; level: 'info' | 'warning' | 'urgent'; title: string; body: string; daysLeft: number | null }) {
  const key = `mailflow.orgBanner.${orgId}`;
  const [hidden, setHidden] = useState(false);
  const { state, note, send } = useRenewalRequest();

  useEffect(() => {
    if (level !== 'info') return;
    try { if (localStorage.getItem(key) === today()) setHidden(true); } catch { /* private window: show it */ }
  }, [key, level]);

  if (hidden) return null;
  return (
    <div role="status" data-org-banner={level} className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-sm lg:mx-3 lg:mt-3 lg:rounded-lg lg:border ${TONE[level]}`}>
      <div className="min-w-0 flex-1">
        <b>{title}</b>
        {daysLeft !== null && daysLeft >= 0 && <span className="ml-2 rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-semibold">{daysLeft === 0 ? 'last day' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}</span>}
        <span className="ml-2 opacity-90">{body}</span>
        {note && <span className="ml-2 block text-xs opacity-80">{note}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={state === 'sending' || state === 'sent' || state === 'already'}
          onClick={() => void send()}
          className="rounded-md border border-current/40 px-3 py-1 text-xs font-semibold hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
        >
          {state === 'sent' ? 'Sent ✓' : state === 'already' ? 'Already requested' : state === 'sending' ? 'Sending…' : 'Request renewal'}
        </button>
        {level === 'info' && (
          <button type="button" aria-label="Dismiss for today" title="Hide for today" onClick={() => { try { localStorage.setItem(key, today()); } catch { /* ignore */ } setHidden(true); }} className="rounded px-1.5 text-lg leading-none opacity-70 hover:opacity-100">×</button>
        )}
      </div>
    </div>
  );
}
