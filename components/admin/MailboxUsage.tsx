'use client';

import { useEffect, useState } from 'react';

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
          const j = await r.json();
          if (!r.ok) throw new Error(j.error ?? 'Could not load mailbox usage.');
          setData(j);
        })
        .catch((e) => setError(String(e.message ?? e)));
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data.mailboxes.length) return <p className="text-sm text-muted-foreground">No mailboxes connected yet.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Person · mailbox</th>
            <th className="py-1.5 pr-3 font-medium">Campaign emails</th>
            <th className="py-1.5 pr-3 font-medium">Recruiter sends</th>
            <th className="py-1.5 pr-3 font-medium">Against Google&apos;s daily limits</th>
          </tr>
        </thead>
        <tbody>
          {data.mailboxes.map((m) => (
            <tr key={m.id} className="border-t border-border-subtle align-top">
              <td className="py-2 pr-3">
                <div className="font-medium">{m.owner?.name ?? m.owner?.email ?? '—'}</div>
                <div className="text-xs text-muted-foreground">{m.emailAddress}</div>
                {m.status !== 'CONNECTED' && <div className="text-xs text-red-600">{m.status.toLowerCase()}</div>}
                {m.pausedUntil && (
                  <div className="text-xs text-amber-700 dark:text-amber-400">
                    Paused by Gmail until {new Date(m.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
              </td>
              <td className="py-2 pr-3">{m.campaignEmails.toLocaleString()}</td>
              <td className="py-2 pr-3">
                {m.recruiterMessages.toLocaleString()} email{m.recruiterMessages === 1 ? '' : 's'}
                <div className="text-xs text-muted-foreground">{m.recruiterRecipients.toLocaleString()} recruiters</div>
              </td>
              <td className="space-y-1.5 py-2 pr-3">
                <Bar label="Emails" value={m.messages} max={data.limits.messages} />
                <Bar label="Different people" value={m.uniqueRecipients} max={data.limits.uniqueRecipients} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        Last 24 hours, updated every minute. Every Bcc recipient counts towards a mailbox&apos;s &ldquo;different people&rdquo; limit. When a mailbox is near a
        limit, sending moves to the next chosen mailbox.
      </p>
    </div>
  );
}
