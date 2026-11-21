'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { STATUS_STYLE } from '@/lib/recruiterSend/ui';
import { LoadingScreen } from '@/components/loading/LoadingScreen';

interface Source {
  id: string; name: string; subject: string; mode: 'BCC' | 'INDIVIDUAL'; round: number; rootBlastId: string | null;
  completedAt: string | null; sent: number; replied: number; opened: number; followUps: number;
}
interface FollowUp {
  id: string; name: string; subject: string; mode: 'BCC' | 'INDIVIDUAL'; status: string; round: number; parentBlastId: string | null; parentName: string | null;
  followUpAudience: string | null; createdAt: string; scheduledAt: string | null; note: string | null; sent: number; replied: number; opened: number;
}

const AUDIENCE: Record<string, string> = {
  NOT_REPLIED: 'Not replied', NOT_REPLIED_OPENED: 'Not replied, opened', NOT_REPLIED_UNOPENED: 'Not replied, not opened', EVERYONE: 'Everyone sent',
};

/** Mail → Recruiter Follow-up (admins): pick a finished send, write the next email, send it in the same thread. */
export default function RecruiterFollowUpList() {
  const router = useRouter();
  const [data, setData] = useState<{ sources: Source[]; followUps: FollowUp[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch('/api/recruiter-follow-ups', { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? 'Could not load follow-ups.');
        setData(j);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  async function create(parentId: string) {
    setBusy(parentId);
    const res = await fetch('/api/recruiter-follow-ups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId, audience: 'NOT_REPLIED' }) }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    setBusy(null);
    if (res?.ok && j?.id) router.push(`/recruiter-follow-up/${j.id}`);
    else toast.error(j?.error ?? 'Could not start the follow-up.');
  }

  const sources = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.sources ?? []).filter((s) => !needle || `${s.name} ${s.subject}`.toLowerCase().includes(needle));
  }, [data, q]);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight">Recruiter Follow-up</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Send a follow-up to the recruiters of a send that has finished. Pick the send, see what went out, write the next email and choose who gets it (for example, only those who have not replied).
          It goes into the same Gmail thread from the same mailbox. You can follow up as many rounds as you like.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!data && !error && <LoadingScreen />}

      {data && (
        <>
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-heading text-sm font-semibold">Finished sends to follow up</h2>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or subject" className="w-64 rounded border bg-background px-2 py-1 text-sm" aria-label="Search finished sends" />
            </div>
            {sources.length === 0 ? (
              <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">{data.sources.length ? 'No send matches your search.' : 'No finished send yet. A send appears here once it has completed and sent at least one email.'}</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Send</th>
                      <th className="px-3 py-2 font-medium">Finished</th>
                      <th className="px-3 py-2 font-medium">Sent</th>
                      <th className="px-3 py-2 font-medium">Replied</th>
                      <th className="px-3 py-2 font-medium">Opened</th>
                      <th className="px-3 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => (
                      <tr key={s.id} className="border-t border-border-subtle align-top">
                        <td className="px-3 py-2">
                          <Link href={`/recruiter-send/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                          {s.round > 1 && <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100">Round {s.round}</span>}
                          {s.followUps > 0 && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{s.followUps} follow-up{s.followUps === 1 ? '' : 's'} made</span>}
                          <div className="text-xs text-muted-foreground">{s.mode === 'BCC' ? 'BCC groups' : 'Individual copies'} · {s.subject || '(no subject)'}</div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{s.completedAt ? new Date(s.completedAt).toLocaleDateString() : '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2">{s.sent.toLocaleString()}</td>
                        <td className="whitespace-nowrap px-3 py-2">{s.replied.toLocaleString()}</td>
                        <td className="whitespace-nowrap px-3 py-2">{s.mode === 'INDIVIDUAL' ? s.opened.toLocaleString() : <span className="text-muted-foreground" title="Opens aren't tracked for BCC sends">—</span>}</td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => create(s.id)} disabled={busy !== null} className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
                            {busy === s.id ? 'Starting…' : 'Follow up'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-heading text-sm font-semibold">Your follow-ups</h2>
            {data.followUps.length === 0 ? (
              <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">No follow-ups yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Follow-up</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Sent</th>
                      <th className="px-3 py-2 font-medium">Replied</th>
                      <th className="px-3 py-2 font-medium">Opened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.followUps.map((f) => (
                      <tr key={f.id} className="border-t border-border-subtle align-top">
                        <td className="px-3 py-2">
                          <Link href={`/recruiter-follow-up/${f.id}`} className="font-medium hover:underline">{f.name}</Link>
                          <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100">Round {f.round}</span>
                          <div className="text-xs text-muted-foreground">
                            {f.subject || '(no subject yet)'}{f.parentName ? ` · follows “${f.parentName}”` : ''}{f.followUpAudience ? ` · ${AUDIENCE[f.followUpAudience] ?? f.followUpAudience}` : ''} · {new Date(f.createdAt).toLocaleDateString()}
                          </div>
                          {f.note && <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">{f.note}</div>}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[f.status] ?? ''}`}>{f.status.toLowerCase()}</span>
                          {f.status === 'SCHEDULED' && f.scheduledAt && <div className="mt-1 text-xs text-muted-foreground">{new Date(f.scheduledAt).toLocaleString()}</div>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{f.sent.toLocaleString()}</td>
                        <td className="whitespace-nowrap px-3 py-2">{f.replied.toLocaleString()}</td>
                        <td className="whitespace-nowrap px-3 py-2">{f.mode === 'INDIVIDUAL' ? f.opened.toLocaleString() : <span className="text-muted-foreground">—</span>}</td>
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
