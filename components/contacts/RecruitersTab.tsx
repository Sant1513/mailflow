'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Avatar } from '@/components/ui/Avatar';
import { ListPager } from '@/components/ui/ListPager';

interface Recruiter { email: string; name: string | null; lastSentAt: string | null; sends: number; blasts: number; lastStatus: string }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const BADGE: Record<string, string> = { SENT: 'badge-success', BOUNCED: 'badge-danger', SKIPPED: 'badge-neutral', PENDING: 'badge-neutral' };

/**
 * The recruiters emailed through Recruiter Bulk Send, one line per address. They are not saved as contacts (tens of thousands
 * of rows would be copied for nothing), so they are listed here and in History. Admins see their organisation's, a Super
 * Admin every organisation's.
 */
export function RecruitersTab({ q }: { q: string }) {
  const [rows, setRows] = useState<Recruiter[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPage(1), [q, pageSize]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const t = setTimeout(async () => {
      const res = await fetch(`/api/recruiters?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`, { cache: 'no-store' }).catch(() => null);
      if (!live) return;
      if (!res?.ok) { setError(res?.status === 403 ? 'Recruiter lists are for admins.' : 'Could not load the recruiters.'); setLoading(false); return; }
      const j = await res.json();
      setRows(j.recruiters ?? []);
      setTotal(j.total ?? 0);
      setError(null);
      setLoading(false);
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, page, pageSize]);

  if (error) return <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</div>;
  return (
    <div data-recruiters-tab>
      <p className="mb-3 text-xs text-muted-foreground">People emailed through Recruiter Bulk Send. They are not saved as contacts, so they are listed here and under History → Recruiter Bulk Send.</p>
      <ListPager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} noun="recruiters" />
      <div className={`overflow-x-auto rounded-lg border bg-card transition-opacity ${loading ? 'opacity-60' : ''}`}>
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr><th className="px-4 py-2">Recruiter</th><th className="px-4 py-2">Last emailed</th><th className="px-4 py-2 text-right">Emails</th><th className="px-4 py-2 text-right">Sends</th><th className="px-4 py-2">Last outcome</th><th className="px-4 py-2" /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.email} className="border-t border-border-subtle">
                <td className="px-4 py-2"><span className="flex items-center gap-2.5"><Avatar email={r.email} name={r.name} size={28} /><span><span className="block">{r.email}</span>{r.name && <span className="block text-xs text-faint">{r.name}</span>}</span></span></td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{when(r.lastSentAt)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r.sends}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r.blasts}</td>
                <td className="px-4 py-2"><span className={`badge ${BADGE[r.lastStatus] ?? 'badge-neutral'}`}>{r.lastStatus.toLowerCase()}</span></td>
                <td className="px-4 py-2 text-right text-xs"><Link href={`/history?tab=recruiter&q=${encodeURIComponent(r.email)}`} className="underline">What we sent</Link></td>
              </tr>
            ))}
            {!loading && rows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">{q ? 'No recruiter matches that.' : 'No Recruiter Bulk Send emails yet.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
