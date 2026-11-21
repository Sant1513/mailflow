'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import { Avatar } from '@/components/ui/Avatar';
import { ListPager } from '@/components/ui/ListPager';
import { LoadingScreen } from '@/components/loading/LoadingScreen';
import { contextLine } from '@/lib/loading/pick';
import { CoolOffBadge, LastEmailedCell, RecentlyEmailedFilter } from '@/components/contacts/EmailedBits';
import { DEFAULT_RECENT_DAYS, emailedQuery, isCoolingOff, type EmailedFilter, type LastEmailedInfo } from '@/lib/contacts/recentEmailed';

interface ContactRow {
  id: string;
  name: string | null;
  primaryEmail: string;
  _count: { records: number; conversations: number };
  doNotContactUntil: string | null;
  coolOffNote: string | null;
  lastEmailed: LastEmailedInfo | null;
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [q, setQ] = useState('');
  const [emailed, setEmailed] = useState<EmailedFilter>({ mode: 'any', days: DEFAULT_RECENT_DAYS });
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [filling, setFilling] = useState(false);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Names for contacts without one, from their lists and their replies (never overwrites).
  async function fillNames() {
    setFilling(true);
    const res = await fetch('/api/contacts/fill-names', { method: 'POST' }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    setFilling(false);
    if (!res?.ok) return toast.error(j?.error ?? 'Could not fill the names.');
    toast.success(j.total ? `Added ${j.total.toLocaleString()} name${j.total === 1 ? '' : 's'}: ${j.fromLists} from your lists, ${j.fromReplies} from replies${j.fromGoogle ? `, ${j.fromGoogle} from Google` : ''}.` : 'No new names found — turn on profile photos in Settings → Gmail to add names from Google too.');
    setReload((n) => n + 1);
  }

  // A new search starts again at page 1.
  useEffect(() => setPage(1), [q, pageSize, emailed]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      setLoading(true);
      const res = await fetch(`/api/contacts?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}${emailedQuery(emailed)}`).catch(() => null);
      const json = await res?.json().catch(() => ({}));
      if (!live) return;
      if (!res?.ok) setError(json?.error ?? 'Could not load contacts.');
      else {
        setError(null);
        setContacts(json.contacts ?? []);
        setTotal(json.total ?? json.contacts?.length ?? 0);
      }
      setLoading(false);
      setLoadedOnce(true);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, emailed, reload, page, pageSize]);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="mb-1 font-heading text-2xl font-bold tracking-tight">Contacts{total ? <span className="ml-2 align-middle text-sm font-normal text-muted-foreground">{total.toLocaleString('en-IN')}{q || emailed.mode !== 'any' ? ' found' : ' in all'}</span> : null}</h1>
          <p className="text-sm text-muted-foreground">
            One person, resolved across every dataset and conversation.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={fillNames} disabled={filling} className="btn-secondary text-sm disabled:opacity-50" title="From their recipient lists and their replies; never overwrites a name">
            {filling ? 'Filling…' : 'Fill missing names'}
          </button>
          <Link href="/contacts/segments" className="btn-secondary text-sm">
            Segments
          </Link>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or email…"
          className="w-full max-w-sm btn-secondary"
        />
        <RecentlyEmailedFilter value={emailed} onChange={setEmailed} />
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error} <button type="button" onClick={() => setReload((n) => n + 1)} className="ml-2 underline">Try again</button></div>
      ) : loading && contacts.length === 0 ? (
        loadedOnce ? <div className="text-sm text-muted-foreground">Loading…</div> : <LoadingScreen context={[contextLine('Looking for “{}”…', q)]} />
      ) : contacts.length === 0 ? (
        <div className="mt-16 text-center text-sm text-muted-foreground">
          {q || emailed.mode !== 'any' ? <>No contacts match{q ? <> “{q}”</> : null}{emailed.mode !== 'any' ? ' this emailed filter' : ''}.</> : <>No contacts yet — they&apos;re created automatically when you import a dataset with an email column.</>}
        </div>
      ) : (
        <>
        <ListPager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} noun="contacts" />
        <div className={`overflow-x-auto rounded-lg border bg-card transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <table className="w-full min-w-[680px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Records</th>
                <th className="px-4 py-2">Conversations</th>
                <th className="px-4 py-2">Last emailed</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-t hover:bg-elevated/60">
                  <td className="px-4 py-2">
                    <Link href={`/contacts/${c.id}`} className="flex items-center gap-2.5 font-medium text-primary hover:underline">
                      <Avatar email={c.primaryEmail} name={c.name} size={28} />
                      {c.name || '—'}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {c.primaryEmail}
                    {isCoolingOff(c.doNotContactUntil) && c.doNotContactUntil && (
                      <div className="mt-0.5" title={c.coolOffNote ?? undefined}><CoolOffBadge until={c.doNotContactUntil} /></div>
                    )}
                  </td>
                  <td className="px-4 py-2">{c._count.records}</td>
                  <td className="px-4 py-2">{c._count.conversations}</td>
                  <td className="max-w-[260px] px-4 py-2"><LastEmailedCell info={c.lastEmailed} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ListPager page={page} pageSize={pageSize} total={total} onPage={setPage} noun="contacts" />
        </>
      )}
    </div>
  );
}
