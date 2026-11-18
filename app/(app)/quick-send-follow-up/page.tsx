'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

interface Source {
  id: string; name: string; subject: string; round: number; status: string; finishedAt: string;
  sent: number; opened: number; replied: number; followUps: number;
}
interface FollowUp {
  id: string; name: string; subject: string; round: number; status: string; followUpAudience: string | null; createdAt: string; scheduledAt: string | null;
  parentName: string | null; sent: number; opened: number; replied: number;
}

const STATUS_WORDS = (s: string) => s.toLowerCase().replace(/_/g, ' ');

/** Mail → Quick Send Follow-up: pick a finished Quick Send, write the next email, send it in each person's thread. */
export default function QuickSendFollowUpList() {
  const [data, setData] = useState<{ sources: Source[]; followUps: FollowUp[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch('/api/quick-send-follow-up', { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? 'Could not load follow-ups.');
        setData(j);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const sources = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.sources ?? []).filter((s) => !needle || `${s.name} ${s.subject}`.toLowerCase().includes(needle));
  }, [data, q]);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <div>
        <div className="eyebrow mb-2">Mail</div>
        <h1 className="font-heading text-2xl font-bold tracking-tight">Quick Send Follow-up</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Follow up the people of a Quick Send that has finished. Pick the send, see what went out, write the next email and choose who gets it (for example, only those who have not replied).
          It goes into each person&apos;s Gmail thread from the same mailbox. You can follow up as many rounds as you like.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && (
        <>
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Finished Quick Sends to follow up</h2>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or subject" className="w-64 rounded-md border border-border bg-background px-3 py-1.5 text-sm" aria-label="Search finished sends" />
            </div>
            {sources.length === 0 ? (
              <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">{data.sources.length ? 'No send matches your search.' : 'No finished Quick Send yet. A send appears here once it has finished and sent at least one email.'}</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Send</th>
                      <th className="px-3 py-2">Finished</th>
                      <th className="px-3 py-2 text-right">Sent</th>
                      <th className="px-3 py-2 text-right">Opened</th>
                      <th className="px-3 py-2 text-right">Replied</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => (
                      <tr key={s.id} className="border-t border-border-subtle align-top">
                        <td className="px-3 py-2">
                          <Link href={`/campaigns/${s.id}`} className="font-medium hover:text-primary">{s.name}</Link>
                          {s.round > 1 && <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100">Round {s.round}</span>}
                          {s.followUps > 0 && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{s.followUps} follow-up{s.followUps === 1 ? '' : 's'} made</span>}
                          <div className="text-xs text-muted-foreground">{s.subject || '(no subject)'}</div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{new Date(s.finishedAt).toLocaleDateString()}</td>
                        <td className="px-3 py-2 text-right">{s.sent.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">{s.opened.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">{s.replied.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">
                          <Link href={`/quick-send-follow-up/new?from=${s.id}`} className="btn-primary !px-3 !py-1.5 text-xs">Follow up</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Your follow-ups</h2>
            {data.followUps.length === 0 ? (
              <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">No follow-ups yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Follow-up</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Sent</th>
                      <th className="px-3 py-2 text-right">Opened</th>
                      <th className="px-3 py-2 text-right">Replied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.followUps.map((f) => (
                      <tr key={f.id} className="border-t border-border-subtle align-top">
                        <td className="px-3 py-2">
                          <Link href={`/campaigns/${f.id}`} className="font-medium hover:text-primary">{f.name}</Link>
                          <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100">Round {f.round}</span>
                          <div className="text-xs text-muted-foreground">{f.subject}{f.parentName ? ` · follows “${f.parentName}”` : ''} · {new Date(f.createdAt).toLocaleDateString()}</div>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {STATUS_WORDS(f.status)}
                          {f.status === 'SCHEDULED' && f.scheduledAt && <div className="text-muted-foreground">{new Date(f.scheduledAt).toLocaleString()}</div>}
                        </td>
                        <td className="px-3 py-2 text-right">{f.sent.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">{f.opened.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">{f.replied.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
