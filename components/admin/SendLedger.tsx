'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { ArrowDownUp, Check, ChevronDown, Download, Filter, Megaphone, MessageSquareReply, RotateCcw, Send, Shuffle, Users, Zap } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { CountUp, Skeleton, Stagger, StaggerItem } from '@/components/motion/Motion';

/**
 * Super Admin → Organization → "Everything sent": every email from every workspace — campaigns,
 * Quick Send, Recruiter Bulk Send and inbox replies — by type, by the user who launched it, and
 * by the mailbox that carried it (including teammates' backup mailboxes), with filters kept in
 * the URL so a filtered view can be shared. Data: GET /api/admin/send-ledger.
 */
type Source = 'CAMPAIGN' | 'QUICK_SEND' | 'RECRUITER' | 'INBOX_REPLY';
const SOURCES: { key: Source; label: string; color: string; icon: typeof Send }[] = [
  { key: 'CAMPAIGN', label: 'Campaigns', color: '#ED0331', icon: Megaphone },
  { key: 'QUICK_SEND', label: 'Quick Send', color: '#F97316', icon: Zap },
  { key: 'RECRUITER', label: 'Recruiter Bulk Send', color: '#8B5CF6', icon: Send },
  { key: 'INBOX_REPLY', label: 'Inbox replies', color: '#0EA5E9', icon: MessageSquareReply },
];
const LABEL: Record<Source, string> = Object.fromEntries(SOURCES.map((s) => [s.key, s.label])) as Record<Source, string>;

interface Option { id: string; name: string }
interface Data {
  from: string;
  to: string;
  options: { workspaces: Option[]; users: (Option & { email: string })[]; mailboxes: (Option & { status: string })[] };
  report: {
    totals: { emails: number; people: number; failed: number; borrowed: number; senders: number; mailboxes: number; replies: number; replyRate: number | null };
    bySource: { source: Source; emails: number; people: number; failed: number; borrowed: number }[];
    byDay: { day: string; source: Source; emails: number }[];
    byUser: { userId: string; name: string; email: string; workspace: string | null; emails: number; people: number; failed: number; bySource: Record<Source, number>; fromOwnMailbox: number; fromOthersMailboxes: number; othersUsedTheirMailbox: number; replies: number; lastAt: string | null }[];
    byMailbox: { accountId: string; emailAddress: string; ownerName: string | null; emails: number; people: number; byOwner: number; byOthers: number; senders: { userId: string; name: string; emails: number }[]; last24h: number | null; dailyLimit: number }[];
    borrowedPairs: { launchedBy: string; launchedByName: string; owner: string; ownerName: string; mailbox: string; emails: number; people: number }[];
    sends: { source: Source; refId: string; name: string; launchedBy: string; launchedByName: string; workspace: string | null; mailboxes: string[]; emails: number; people: number; failed: number; replies: number; firstAt: string; lastAt: string; borrowed: boolean }[];
  };
}

const fmt = (v: number) => v.toLocaleString('en-IN');
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\n');
}
function download(name: string, rows: (string | number)[][]) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Dropdown with search and checkboxes; selected ids live in the URL. */
function MultiSelect({ label, options, value, onChange }: { label: string; options: Option[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const shown = options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  const summary = value.length === 0 ? 'All' : value.length === 1 ? options.find((o) => o.id === value[0])?.name ?? '1 selected' : `${value.length} selected`;
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs ${value.length ? 'border-ink bg-ink text-ink-foreground' : 'border-border-subtle bg-card text-muted-foreground hover:text-foreground'}`}>
        <span className="font-medium">{label}:</span>
        <span className="max-w-[10rem] truncate">{summary}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="glass-nav absolute left-0 top-11 z-30 w-72 rounded-2xl p-2">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} className="mb-1 w-full rounded-lg border border-border-subtle bg-muted px-2 py-1.5 text-xs" />
          <div className="max-h-64 overflow-auto">
            {shown.map((o) => {
              const on = value.includes(o.id);
              return (
                <button key={o.id} type="button" onClick={() => onChange(on ? value.filter((v) => v !== o.id) : [...value, o.id])} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-elevated">
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? 'border-ink bg-ink text-ink-foreground' : 'border-border'}`}>{on && <Check size={11} />}</span>
                  <span className="min-w-0 truncate">{o.name}</span>
                </button>
              );
            })}
            {!shown.length && <p className="px-2 py-3 text-center text-xs text-faint">Nothing matches.</p>}
          </div>
          {value.length > 0 && <button type="button" onClick={() => onChange([])} className="mt-1 w-full rounded-lg px-2 py-1 text-xs text-primary hover:bg-elevated">Clear</button>}
        </div>
      )}
    </div>
  );
}

type SortKey = 'name' | 'emails' | 'people' | 'own' | 'others' | 'usedByOthers' | 'replies' | 'lastAt';

export function SendLedger() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'emails', dir: -1 });

  const get = (k: string) => params.get(k) ?? '';
  const ids = (k: string) => (params.get(k) ? params.get(k)!.split(',').filter(Boolean) : []);
  const filters = {
    days: get('ldays') || (get('lfrom') ? '' : '30'),
    from: get('lfrom'),
    to: get('lto'),
    workspace: ids('lws'),
    user: ids('luser'),
    mailbox: ids('lmb'),
    type: ids('ltype') as Source[],
    status: get('lstatus'),
    borrowed: get('lborrowed') === '1',
  };
  const active = filters.workspace.length + filters.user.length + filters.mailbox.length + filters.type.length + (filters.status ? 1 : 0) + (filters.borrowed ? 1 : 0) + (filters.from ? 1 : 0);

  const set = useCallback((patch: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      const s = Array.isArray(v) ? v.join(',') : v;
      if (s) next.set(k, s);
      else next.delete(k);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [params, pathname, router]);

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (filters.from && filters.to) { q.set('from', filters.from); q.set('to', filters.to); } else q.set('days', filters.days || '30');
    if (filters.workspace.length) q.set('workspace', filters.workspace.join(','));
    if (filters.user.length) q.set('user', filters.user.join(','));
    if (filters.mailbox.length) q.set('mailbox', filters.mailbox.join(','));
    if (filters.type.length) q.set('type', filters.type.join(','));
    if (filters.status) q.set('status', filters.status);
    if (filters.borrowed) q.set('borrowed', '1');
    return q.toString();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(`/api/admin/send-ledger?${query}`, { cache: 'no-store' })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j?.error ?? 'Could not load'); return j; })
      .then((j) => live && (setData(j), setError(null)))
      .catch((e) => live && setError(String(e.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [query]);

  const chart = useMemo(() => {
    if (!data) return [];
    const byDay = new Map<string, Record<string, number | string>>();
    for (const r of data.report.byDay) {
      const row = byDay.get(r.day) ?? { day: r.day, CAMPAIGN: 0, QUICK_SEND: 0, RECRUITER: 0, INBOX_REPLY: 0 };
      row[r.source] = Number(row[r.source] ?? 0) + r.emails;
      byDay.set(r.day, row);
    }
    return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }, [data]);

  const users = useMemo(() => {
    if (!data) return [];
    const val = (u: Data['report']['byUser'][number]): string | number => ({ name: u.name.toLowerCase(), emails: u.emails, people: u.people, own: u.fromOwnMailbox, others: u.fromOthersMailboxes, usedByOthers: u.othersUsedTheirMailbox, replies: u.replies, lastAt: u.lastAt ?? '' }[sort.key]);
    return [...data.report.byUser].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir);
  }, [data, sort]);

  const th = (key: SortKey, label: string, right = true) => (
    <th className={`px-3 py-2 font-medium ${right ? 'text-right' : ''}`}>
      <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 }))} className={`inline-flex items-center gap-1 ${sort.key === key ? 'text-foreground' : ''}`}>
        {label}<ArrowDownUp size={11} className={sort.key === key ? 'opacity-100' : 'opacity-40'} />
      </button>
    </th>
  );

  const t = data?.report.totals;
  const periodLabel = filters.from && filters.to ? `${filters.from} → ${filters.to}` : `last ${filters.days || 30} days`;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-bold text-foreground">Everything sent</h2>
          <p className="text-xs text-faint">Every email from every workspace — campaigns, Quick Send, Recruiter Bulk Send and inbox replies — {periodLabel}. Who launched it, and whose mailbox carried it.</p>
        </div>
        {loading && <span className="text-xs text-faint">Updating…</span>}
      </div>

      {/* Filters */}
      <div className="panel flex flex-wrap items-center gap-2 p-3">
        <Filter size={15} className="text-faint" />
        <div className="segmented">
          {['7', '30', '90'].map((d) => {
            const on = !filters.from && (filters.days || '30') === d;
            return <button key={d} type="button" onClick={() => set({ ldays: d, lfrom: null, lto: null })} className={`rounded-full px-3 py-1 text-xs font-semibold ${on ? 'bg-ink text-ink-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{d}d</button>;
          })}
        </div>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">From <input type="date" value={filters.from} onChange={(e) => set({ lfrom: e.target.value, lto: filters.to || new Date().toISOString().slice(0, 10), ldays: null })} className="h-9 rounded-full border border-border-subtle bg-card px-2 text-xs" /></label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">To <input type="date" value={filters.to} onChange={(e) => set({ lto: e.target.value, lfrom: filters.from || e.target.value, ldays: null })} className="h-9 rounded-full border border-border-subtle bg-card px-2 text-xs" /></label>
        {data && (
          <>
            <MultiSelect label="Workspace" options={data.options.workspaces} value={filters.workspace} onChange={(v) => set({ lws: v })} />
            <MultiSelect label="Launched by" options={data.options.users} value={filters.user} onChange={(v) => set({ luser: v })} />
            <MultiSelect label="Mailbox" options={data.options.mailboxes} value={filters.mailbox} onChange={(v) => set({ lmb: v })} />
            <MultiSelect label="Type" options={SOURCES.map((s) => ({ id: s.key, name: s.label }))} value={filters.type} onChange={(v) => set({ ltype: v })} />
          </>
        )}
        <select value={filters.status} onChange={(e) => set({ lstatus: e.target.value || null })} className="h-9 rounded-full border border-border-subtle bg-card px-3 text-xs" aria-label="Status">
          <option value="">Sent + failed</option>
          <option value="SENT">Sent only</option>
          <option value="FAILED">Failed only</option>
        </select>
        <button type="button" onClick={() => set({ lborrowed: filters.borrowed ? null : '1' })} className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs ${filters.borrowed ? 'border-ink bg-ink text-ink-foreground' : 'border-border-subtle bg-card text-muted-foreground hover:text-foreground'}`}>
          <Shuffle size={13} /> Only from someone else&apos;s mailbox
        </button>
        {active > 0 && (
          <button type="button" onClick={() => set({ lws: null, luser: null, lmb: null, ltype: null, lstatus: null, lborrowed: null, lfrom: null, lto: null, ldays: null })} className="ml-auto flex h-9 items-center gap-1 rounded-full px-3 text-xs text-primary hover:bg-elevated">
            <RotateCcw size={13} /> Reset ({active})
          </button>
        )}
      </div>

      {error && <p className="panel p-4 text-sm text-destructive">{error}</p>}
      {!data && !error && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <div key={i} className="panel space-y-2 p-4"><Skeleton className="h-7 w-20" /><Skeleton className="h-3 w-24" /></div>)}</div>
      )}

      {data && t && (
        <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          {/* Totals */}
          <Stagger key={query} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { label: 'Emails sent', value: fmt(t.emails), note: `${t.mailboxes} mailbox${t.mailboxes === 1 ? '' : 'es'}` },
              { label: 'People reached', value: fmt(t.people), note: 'To + Cc + Bcc' },
              { label: 'Failed', value: fmt(t.failed), warn: t.failed > 0 },
              { label: "From others' mailboxes", value: fmt(t.borrowed), note: 'backup / teammates' },
              { label: 'Replies received', value: fmt(t.replies), note: t.replyRate !== null ? `${t.replyRate}% of emails` : '' },
              { label: 'People who sent', value: fmt(t.senders), note: 'launched something' },
            ].map((s) => (
              <StaggerItem key={s.label}>
                <div className="panel lift h-full p-4">
                  <div className={`font-heading text-2xl font-bold ${s.warn ? 'text-warning' : 'text-foreground'}`}><CountUp value={s.value} /></div>
                  <div className="mt-0.5 text-sm font-medium text-foreground">{s.label}</div>
                  {s.note && <div className="text-xs text-faint">{s.note}</div>}
                </div>
              </StaggerItem>
            ))}
          </Stagger>

          {/* By type (click to filter) */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SOURCES.map((s) => {
              const r = data.report.bySource.find((x) => x.source === s.key);
              const on = filters.type.includes(s.key);
              const Icon = s.icon;
              return (
                <button key={s.key} type="button" onClick={() => set({ ltype: on ? filters.type.filter((x) => x !== s.key) : [...filters.type, s.key] })} className={`panel lift flex items-start gap-3 p-4 text-left ${on ? 'ring-2 ring-ink' : ''}`} title="Click to filter by this type">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: s.color }}><Icon size={18} /></span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-foreground">{s.label}</span>
                    <span className="block text-xs text-muted-foreground">{fmt(r?.emails ?? 0)} emails · {fmt(r?.people ?? 0)} people</span>
                    <span className="block text-[11px] text-faint">{fmt(r?.borrowed ?? 0)} from others&apos; mailboxes{r?.failed ? ` · ${fmt(r.failed)} failed` : ''}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* By day */}
          <div className="panel p-5">
            <div className="mb-2 font-heading text-sm font-semibold text-foreground">Emails by day, by type</div>
            <div style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
                  <XAxis dataKey="day" tickFormatter={(d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} tick={{ fill: 'hsl(var(--faint))', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: 'hsl(var(--faint))', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: 'hsl(var(--elevated))' }} contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }} labelFormatter={(d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { dateStyle: 'medium' })} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v: string) => LABEL[v as Source] ?? v} />
                  {SOURCES.map((s, i) => <Bar key={s.key} dataKey={s.key} stackId="a" fill={s.color} radius={i === SOURCES.length - 1 ? [6, 6, 0, 0] : 0} animationDuration={800} />)}
                </BarChart>
              </ResponsiveContainer>
            </div>
            {!chart.length && <p className="text-center text-xs text-faint">Nothing sent in this period with these filters.</p>}
          </div>

          {/* By user */}
          <div className="panel overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-2 font-heading text-sm font-semibold text-foreground"><Users size={16} /> By user</div>
              <button type="button" onClick={() => download('mailflow-sends-by-user.csv', [['User', 'Email', 'Workspace', 'Emails', 'People', 'Campaigns', 'Quick Send', 'Recruiter', 'Inbox replies', 'From own mailbox', "From others' mailboxes", 'Others used their mailbox', 'Failed', 'Replies received', 'Last sent'], ...users.map((u) => [u.name, u.email, u.workspace ?? '', u.emails, u.people, u.bySource.CAMPAIGN, u.bySource.QUICK_SEND, u.bySource.RECRUITER, u.bySource.INBOX_REPLY, u.fromOwnMailbox, u.fromOthersMailboxes, u.othersUsedTheirMailbox, u.failed, u.replies, u.lastAt ?? ''])])} className="flex items-center gap-1 text-xs text-faint hover:text-foreground"><Download size={13} /> CSV</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead className="border-y border-border-subtle text-left text-[11px] uppercase tracking-wide text-faint">
                  <tr>
                    {th('name', 'User', false)}
                    {th('emails', 'Emails')}
                    {th('people', 'People')}
                    <th className="px-3 py-2 font-medium">By type</th>
                    {th('own', 'Own mailbox')}
                    {th('others', "Others' mailboxes")}
                    {th('usedByOthers', 'Theirs used by others')}
                    {th('replies', 'Replies')}
                    {th('lastAt', 'Last sent')}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.userId} className="border-b border-border-subtle last:border-0 hover:bg-elevated/60">
                      <td className="px-3 py-2.5">
                        <button type="button" onClick={() => set({ luser: [u.userId] })} className="flex items-center gap-2.5 text-left" title="Show only this user's sends">
                          <Avatar email={u.email} name={u.name} size={30} />
                          <span className="min-w-0"><span className="block font-medium text-foreground hover:underline">{u.name}</span><span className="block text-xs text-faint">{u.workspace ?? u.email}</span></span>
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right font-semibold text-foreground">{fmt(u.emails)}</td>
                      <td className="px-3 py-2.5 text-right">{fmt(u.people)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex h-2 w-36 overflow-hidden rounded-full bg-muted" title={SOURCES.map((s) => `${s.label}: ${u.bySource[s.key]}`).join(' · ')}>
                          {SOURCES.map((s) => (u.emails ? <span key={s.key} style={{ width: `${(u.bySource[s.key] / u.emails) * 100}%`, background: s.color }} /> : null))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">{fmt(u.fromOwnMailbox)}</td>
                      <td className={`px-3 py-2.5 text-right ${u.fromOthersMailboxes ? 'font-medium text-foreground' : 'text-faint'}`}>{fmt(u.fromOthersMailboxes)}</td>
                      <td className={`px-3 py-2.5 text-right ${u.othersUsedTheirMailbox ? 'font-medium text-foreground' : 'text-faint'}`}>{fmt(u.othersUsedTheirMailbox)}</td>
                      <td className="px-3 py-2.5 text-right">{fmt(u.replies)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs text-faint">{when(u.lastAt)}</td>
                    </tr>
                  ))}
                  {!users.length && <tr><td colSpan={9} className="px-5 py-6 text-center text-sm text-faint">Nobody sent anything with these filters.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {/* By mailbox */}
            <div className="panel overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4">
                <div className="font-heading text-sm font-semibold text-foreground">By mailbox</div>
                <button type="button" onClick={() => download('mailflow-sends-by-mailbox.csv', [['Mailbox', 'Owner', 'Emails', 'People', 'By owner', 'By others', 'Sent in last 24h', 'Daily limit', 'Who sent'], ...data.report.byMailbox.map((m) => [m.emailAddress, m.ownerName ?? '', m.emails, m.people, m.byOwner, m.byOthers, m.last24h ?? '', m.dailyLimit, m.senders.map((s) => `${s.name} (${s.emails})`).join('; ')])])} className="flex items-center gap-1 text-xs text-faint hover:text-foreground"><Download size={13} /> CSV</button>
              </div>
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="sticky top-0 border-y border-border-subtle bg-card text-left text-[11px] uppercase tracking-wide text-faint">
                    <tr><th className="px-3 py-2 font-medium">Mailbox</th><th className="px-3 py-2 text-right font-medium">Emails</th><th className="px-3 py-2 font-medium">Who sent from it</th><th className="px-3 py-2 font-medium">Today</th></tr>
                  </thead>
                  <tbody>
                    {data.report.byMailbox.map((m) => {
                      const pct = m.last24h !== null ? Math.min(100, (m.last24h / m.dailyLimit) * 100) : 0;
                      return (
                        <tr key={m.accountId} className="border-b border-border-subtle align-top last:border-0">
                          <td className="px-3 py-2.5"><button type="button" onClick={() => set({ lmb: [m.accountId] })} className="flex items-center gap-2 text-left" title="Show only this mailbox"><Avatar email={m.emailAddress} name={m.ownerName} size={26} /><span className="min-w-0"><span className="block max-w-[14rem] truncate text-xs font-medium text-foreground hover:underline">{m.emailAddress}</span><span className="block text-[11px] text-faint">{m.ownerName}</span></span></button></td>
                          <td className="px-3 py-2.5 text-right font-semibold text-foreground">{fmt(m.emails)}<span className="block text-[11px] font-normal text-faint">{fmt(m.people)} people</span></td>
                          <td className="px-3 py-2.5 text-xs">{m.senders.slice(0, 3).map((s) => <span key={s.userId} className="block">{s.name} <span className="text-faint">· {fmt(s.emails)}</span></span>)}{m.byOthers > 0 && <span className="mt-0.5 inline-block rounded-full bg-warning/15 px-1.5 text-[10px] text-warning">{fmt(m.byOthers)} by others</span>}</td>
                          <td className="px-3 py-2.5 text-xs">{m.last24h !== null ? <><div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"><div className={`h-full ${pct > 85 ? 'bg-destructive' : 'bg-success'}`} style={{ width: `${pct}%` }} /></div><span className="text-[11px] text-faint">{fmt(m.last24h)} / {fmt(m.dailyLimit)}</span></> : '—'}</td>
                        </tr>
                      );
                    })}
                    {!data.report.byMailbox.length && <tr><td colSpan={4} className="px-5 py-6 text-center text-sm text-faint">No mailbox sent anything with these filters.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Who used whose mailbox */}
            <div className="panel overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-2 font-heading text-sm font-semibold text-foreground"><Shuffle size={16} /> Who used whose mailbox</div>
                <button type="button" onClick={() => download('mailflow-borrowed-mailboxes.csv', [['Launched by', 'Mailbox', 'Mailbox owner', 'Emails', 'People'], ...data.report.borrowedPairs.map((p) => [p.launchedByName, p.mailbox, p.ownerName, p.emails, p.people])])} className="flex items-center gap-1 text-xs text-faint hover:text-foreground"><Download size={13} /> CSV</button>
              </div>
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead className="sticky top-0 border-y border-border-subtle bg-card text-left text-[11px] uppercase tracking-wide text-faint">
                    <tr><th className="px-3 py-2 font-medium">Launched by</th><th className="px-3 py-2 font-medium">Sent from</th><th className="px-3 py-2 text-right font-medium">Emails</th><th className="px-3 py-2 text-right font-medium">People</th></tr>
                  </thead>
                  <tbody>
                    {data.report.borrowedPairs.map((p, i) => (
                      <tr key={i} className="border-b border-border-subtle last:border-0">
                        <td className="px-3 py-2.5 font-medium text-foreground">{p.launchedByName}</td>
                        <td className="px-3 py-2.5"><span className="block text-xs text-foreground">{p.mailbox}</span><span className="block text-[11px] text-faint">{p.ownerName}&apos;s mailbox</span></td>
                        <td className="px-3 py-2.5 text-right font-semibold">{fmt(p.emails)}</td>
                        <td className="px-3 py-2.5 text-right">{fmt(p.people)}</td>
                      </tr>
                    ))}
                    {!data.report.borrowedPairs.length && <tr><td colSpan={4} className="px-5 py-6 text-center text-sm text-faint">Everyone sent from their own mailbox in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Every send */}
          <div className="panel overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4">
              <div className="font-heading text-sm font-semibold text-foreground">Every send <span className="font-normal text-faint">({fmt(data.report.sends.length)}{data.report.sends.length === 200 ? '+' : ''})</span></div>
              <button type="button" onClick={() => download('mailflow-sends.csv', [['Type', 'Name', 'Launched by', 'Workspace', 'Mailboxes', 'Emails', 'People', 'Failed', 'Replies', 'First sent', 'Last sent', "Used others' mailboxes"], ...data.report.sends.map((s) => [LABEL[s.source], s.name, s.launchedByName, s.workspace ?? '', s.mailboxes.join('; '), s.emails, s.people, s.failed, s.replies, s.firstAt, s.lastAt, s.borrowed ? 'yes' : 'no'])])} className="flex items-center gap-1 text-xs text-faint hover:text-foreground"><Download size={13} /> CSV</button>
            </div>
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="sticky top-0 border-y border-border-subtle bg-card text-left text-[11px] uppercase tracking-wide text-faint">
                  <tr><th className="px-3 py-2 font-medium">Send</th><th className="px-3 py-2 font-medium">Launched by</th><th className="px-3 py-2 font-medium">Mailboxes</th><th className="px-3 py-2 text-right font-medium">Emails</th><th className="px-3 py-2 text-right font-medium">People</th><th className="px-3 py-2 text-right font-medium">Failed</th><th className="px-3 py-2 text-right font-medium">Replies</th><th className="px-3 py-2 text-right font-medium">When</th></tr>
                </thead>
                <tbody>
                  {data.report.sends.map((s) => {
                    const meta = SOURCES.find((x) => x.key === s.source)!;
                    const href = s.source === 'RECRUITER' ? `/recruiter-send/${s.refId}` : `/campaigns/${s.refId}`;
                    return (
                      <tr key={`${s.source}${s.refId}${s.launchedBy}`} className="border-b border-border-subtle align-top last:border-0 hover:bg-elevated/60">
                        <td className="px-3 py-2.5">
                          <Link href={href} className="font-medium text-foreground hover:underline">{s.name}</Link>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint"><span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />{meta.label}{s.workspace ? ` · ${s.workspace}` : ''}</span>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-foreground">{s.launchedByName}</td>
                        <td className="px-3 py-2.5 text-xs">{s.mailboxes.slice(0, 2).map((m) => <span key={m} className="block max-w-[14rem] truncate">{m}</span>)}{s.mailboxes.length > 2 && <span className="text-faint">+{s.mailboxes.length - 2} more</span>}{s.borrowed && <span className="mt-0.5 inline-block rounded-full bg-warning/15 px-1.5 text-[10px] text-warning">others&apos; mailboxes</span>}</td>
                        <td className="px-3 py-2.5 text-right font-semibold">{fmt(s.emails)}</td>
                        <td className="px-3 py-2.5 text-right">{fmt(s.people)}</td>
                        <td className={`px-3 py-2.5 text-right ${s.failed ? 'text-warning' : 'text-faint'}`}>{fmt(s.failed)}</td>
                        <td className="px-3 py-2.5 text-right">{fmt(s.replies)}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs text-faint">{when(s.lastAt)}</td>
                      </tr>
                    );
                  })}
                  {!data.report.sends.length && <tr><td colSpan={8} className="px-5 py-6 text-center text-sm text-faint">No campaigns or sends with these filters.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
