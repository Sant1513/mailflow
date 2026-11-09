'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Status = 'ok' | 'warn' | 'bad';
interface Check { status: Status; label: string; detail: string; rate?: number }
interface Report {
  scope: 'organisation' | 'workspace';
  days: number;
  sent: number;
  rates: { bounce: Check; unsubscribe: Check };
  engagement: { opened: number; clicked: number; automatedHitsFiltered: number };
  mailboxes: { id: string; emailAddress: string; displayName: string | null; status: string; sentLast24h: number; uniqueRecipientsLast24h: number; dailyLimit: number; uniqueLimit: number; pausedUntil: string | null }[];
  authentication: { domain: string; checks: Check[] }[];
  recentBounces: { email: string; detail: string | null; createdAt: string; campaign: { id: string; name: string } | null }[];
}

const DOT: Record<Status, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
};
const WORD: Record<Status, string> = { ok: 'Good', warn: 'Check', bad: 'Fix' };

function StatusBadge({ status }: { status: Status }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${DOT[status]}`} aria-hidden />
      {WORD[status]}
    </span>
  );
}

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

/** Mail → Deliverability: the numbers Google judges a sender on, in one place. */
export default function DeliverabilityPage() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    fetch(`/api/deliverability?days=${days}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? 'Could not load the report.');
        setReport(j);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [days]);

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-bold tracking-tight">Deliverability</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border bg-background px-2 py-1 text-sm" aria-label="Period">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        Google and Yahoo judge every sending mailbox on bounces, complaints and domain authentication. Keep these green and
        campaign emails keep reaching inboxes.{report?.scope === 'organisation' ? ' Showing the whole organisation.' : ''}
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!report && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

      {report && (
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">Emails sent</div>
              <div className="mt-1 text-2xl font-semibold">{report.sent.toLocaleString()}</div>
            </div>
            {[report.rates.bounce, report.rates.unsubscribe].map((c) => (
              <div key={c.label} className="rounded-lg border bg-card p-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  {c.label} <StatusBadge status={c.status} />
                </div>
                <div className="mt-1 text-2xl font-semibold">{((c.rate ?? 0) * 100).toFixed((c.rate ?? 0) < 0.01 ? 2 : 1)}%</div>
                <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>
              </div>
            ))}
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">Opened · clicked (people only)</div>
              <div className="mt-1 text-2xl font-semibold">
                {pct(report.engagement.opened, report.sent)} · {pct(report.engagement.clicked, report.sent)}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {report.engagement.automatedHitsFiltered.toLocaleString()} automated opens/clicks (link scanners, previews) left out.
              </p>
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <h2 className="mb-1 text-sm font-semibold">Domain authentication</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Required by Google and Yahoo. Set in your domain&apos;s DNS and the Google Admin console, not in MailFlow.
            </p>
            {report.authentication.length === 0 && <p className="text-sm text-muted-foreground">No connected mailboxes.</p>}
            {report.authentication.map((d) => (
              <div key={d.domain} className="mb-3 last:mb-0">
                <div className="mb-1 text-sm font-medium">{d.domain}</div>
                <ul className="space-y-1.5">
                  {d.checks.map((c) => (
                    <li key={c.label} className="flex gap-3 text-sm">
                      <span className="w-14 shrink-0 font-medium">{c.label}</span>
                      <span className="w-14 shrink-0"><StatusBadge status={c.status} /></span>
                      <span className="text-muted-foreground">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="mt-3 text-xs text-muted-foreground">
              Spam complaints are only visible in{' '}
              <a href="https://postmaster.google.com/" target="_blank" rel="noopener noreferrer" className="underline">
                Google Postmaster Tools
              </a>
              . Google asks senders to stay under 0.1% and never reach 0.3%.
            </p>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Mailboxes (last 24 hours)</h2>
            {report.mailboxes.length === 0 && <p className="text-sm text-muted-foreground">No connected mailboxes.</p>}
            <div className="space-y-3">
              {report.mailboxes.map((m) => {
                const share = Math.min(1, m.sentLast24h / m.dailyLimit);
                const tone = share >= 0.9 ? 'bg-red-500' : share >= 0.7 ? 'bg-amber-500' : 'bg-primary';
                return (
                  <div key={m.id}>
                    <div className="mb-1 flex flex-wrap justify-between gap-2 text-sm">
                      <span className="truncate">
                        {m.displayName ? `${m.displayName} · ` : ''}
                        {m.emailAddress}
                        {m.status !== 'CONNECTED' && <span className="ml-2 text-xs text-red-600">{m.status.toLowerCase()}</span>}
                        {m.pausedUntil && (
                          <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
                            paused by Gmail until {new Date(m.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {m.sentLast24h.toLocaleString()} / {m.dailyLimit.toLocaleString()} emails · {m.uniqueRecipientsLast24h.toLocaleString()} /{' '}
                        {m.uniqueLimit.toLocaleString()} people
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={m.sentLast24h} aria-valuemax={m.dailyLimit} aria-label={`${m.emailAddress} daily usage`}>
                      <div className={`h-full ${tone}`} style={{ width: `${share * 100}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Recent bounces</h2>
              <Link href="/suppressions" className="text-xs underline">
                All suppressions →
              </Link>
            </div>
            {report.recentBounces.length === 0 ? (
              <p className="text-sm text-muted-foreground">No bounces. 🎉</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Address</th>
                      <th className="py-1 pr-3 font-medium">Why</th>
                      <th className="py-1 pr-3 font-medium">Campaign</th>
                      <th className="py-1 font-medium">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.recentBounces.map((b) => (
                      <tr key={b.email} className="border-t border-border-subtle align-top">
                        <td className="py-1.5 pr-3">{b.email}</td>
                        <td className="max-w-md py-1.5 pr-3 text-xs text-muted-foreground">{b.detail ?? '—'}</td>
                        <td className="py-1.5 pr-3 text-xs">{b.campaign ? <Link href={`/campaigns/${b.campaign.id}`} className="underline">{b.campaign.name}</Link> : '—'}</td>
                        <td className="whitespace-nowrap py-1.5 text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
