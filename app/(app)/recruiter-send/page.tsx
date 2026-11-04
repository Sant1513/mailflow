'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { MailboxUsage } from '@/components/admin/MailboxUsage';
import { STATUS_STYLE } from '@/lib/recruiterSend/ui';

interface Row {
  id: string;
  name: string;
  mode: 'BCC' | 'INDIVIDUAL';
  status: string;
  subject: string;
  createdAt: string;
  startedAt: string | null;
  scheduledAt: string | null;
  note: string | null;
  recipients: number;
  sent: number;
  skipped: number;
  messagesSent: number;
  opens: number;
  openedRecruiters: number | null;
}


/** Mail → Recruiter Bulk Send (admins): past sends and a new one. */
export default function RecruiterSendList() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/recruiter-blasts', { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? 'Could not load recruiter sends.');
        setRows(j.blasts);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  async function create() {
    setBusy(true);
    const res = await fetch('/api/recruiter-blasts', { method: 'POST' }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    setBusy(false);
    if (res?.ok && j?.id) router.push(`/recruiter-send/${j.id}`);
    else toast.error(j?.error ?? 'Could not start a new send.');
  }

  async function copy(id: string) {
    const res = await fetch(`/api/recruiter-blasts/${id}/copy`, { method: 'POST' }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    if (res?.ok && j?.id) router.push(`/recruiter-send/${j.id}`);
    else toast.error(j?.error ?? 'Could not copy.');
  }

  return (
    <div className="max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Recruiter Bulk Send</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            One email to many recruiters — in BCC groups of up to 250, or as individual copies — from the mailboxes you choose. Opens are tracked;
            links are left as you write them.
          </p>
        </div>
        <button type="button" onClick={create} disabled={busy} className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? 'Starting…' : 'New bulk send'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!rows && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {rows && rows.length === 0 && <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">No recruiter sends yet.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Send</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Recruiters</th>
                <th className="px-3 py-2 font-medium">Opens</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border-subtle align-top">
                  <td className="px-3 py-2">
                    <Link href={`/recruiter-send/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {r.mode === 'BCC' ? 'BCC groups' : 'Individual copies'} · {r.subject || '(no subject yet)'} · {new Date(r.createdAt).toLocaleDateString()}
                    </div>
                    {r.note && <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">{r.note}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[r.status] ?? ''}`}>{r.status.toLowerCase()}</span>
                    {r.status === 'SCHEDULED' && r.scheduledAt && <div className="mt-1 text-xs text-muted-foreground">{new Date(r.scheduledAt).toLocaleString()}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {r.sent.toLocaleString()} sent / {r.recipients.toLocaleString()}
                    {r.skipped > 0 && <div className="text-xs text-muted-foreground">{r.skipped} skipped</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {r.mode === 'INDIVIDUAL' ? `${r.openedRecruiters ?? 0} recruiters` : `${r.opens} opens`}
                    <div className="text-xs text-muted-foreground">{r.messagesSent} email{r.messagesSent === 1 ? '' : 's'} sent</div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => copy(r.id)} className="rounded border px-2 py-1 text-xs hover:bg-elevated">
                      Copy
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">Mailbox usage today</h2>
        <MailboxUsage />
      </section>
    </div>
  );
}
