'use client';

import { useEffect, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';

interface Row {
  id: string;
  emailAddress: string;
  status: string;
  owner: { id: string; name: string | null; email: string } | null;
  messages: number;
  campaignEmails: number;
  recruiterMessages: number;
  recruiterRecipients: number;
  uniqueRecipients: number;
  totalRecipients: number;
  pausedUntil: string | null;
}
interface Data {
  limits: { messages: number; uniqueRecipients: number; totalRecipients: number };
  mailboxes: Row[];
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const share = Math.min(1, max ? value / max : 0);
  const tone = share >= 0.9 ? 'bg-red-500' : share >= 0.7 ? 'bg-amber-500' : 'bg-primary';
  return (
    <div className="min-w-[8rem]">
      <div className="mb-0.5 flex justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span>
          {value.toLocaleString()} / {max.toLocaleString()}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={value} aria-valuemax={max} aria-label={label}>
        <div className={`h-full ${tone}`} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Admins: emails sent from each person's mailbox in the last 24 hours (campaigns and recruiter
 * sends together, as Google counts them), against the daily limits.
 */
export function MailboxUsage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch('/api/admin/mailbox-usage', { cache: 'no-store' })
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error ?? 'Could not load mailbox usage.');
          setError(null);
          setData(j);
        })
        .catch((e) => setError(String(e.message ?? e)));
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  // A failed refresh keeps the last numbers on screen (with a note); only a first load shows the error.
  if (error && !data) return <p className="p-4 text-sm text-red-600">{error}</p>;
  if (!data) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!data.mailboxes.length) return <p className="p-4 text-sm text-muted-foreground">No mailboxes connected yet.</p>;

  return (
    <div className="overflow-x-auto">
      {error && <p className="px-4 pt-3 text-xs text-muted-foreground">Couldn&apos;t refresh just now; showing the last numbers.</p>}
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5 font-semibold">Person · mailbox</th>
            <th className="px-4 py-2.5 text-right font-semibold">Campaign emails</th>
            <th className="px-4 py-2.5 text-right font-semibold">Recruiter sends</th>
            <th className="w-[38%] px-4 py-2.5 font-semibold">Against Google&apos;s daily limits</th>
          </tr>
        </thead>
        <tbody>
          {data.mailboxes.map((m) => (
            <tr key={m.id} className="border-t border-border-subtle align-top transition-colors hover:bg-elevated/40">
              <td className="px-4 py-3">
                <div className="flex items-start gap-2.5">
                <Avatar email={m.emailAddress} name={m.owner?.name ?? null} size={30} />
                <div className="min-w-0">
                <div className="font-medium text-foreground">{m.owner?.name ?? m.owner?.email ?? '—'}</div>
                <div className="truncate text-xs text-muted-foreground">{m.emailAddress}</div>
                {m.status !== 'CONNECTED' && <div className="text-xs text-red-600">{m.status.toLowerCase()}</div>}
                {m.pausedUntil && (
                  <div className="text-xs text-amber-700 dark:text-amber-400">
                    Paused by Gmail until {new Date(m.pausedUntil).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
                  </div>
                )}
                </div>
                </div>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{m.campaignEmails.toLocaleString('en-IN')}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                {m.recruiterMessages.toLocaleString('en-IN')} email{m.recruiterMessages === 1 ? '' : 's'}
                <div className="text-xs text-muted-foreground">{m.recruiterRecipients.toLocaleString('en-IN')} recruiters</div>
              </td>
              <td className="space-y-1.5 px-4 py-3">
                <Bar label="Emails" value={m.messages} max={data.limits.messages} />
                <Bar label="Different people" value={m.uniqueRecipients} max={data.limits.uniqueRecipients} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border-subtle px-4 py-3 text-xs text-muted-foreground">
        Last 24 hours, updated every minute. Every Bcc recipient counts towards a mailbox&apos;s &ldquo;different people&rdquo; limit. When a mailbox is near a
        limit, sending moves to the next chosen mailbox.
      </p>
    </div>
  );
}
