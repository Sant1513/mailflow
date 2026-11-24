'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadGate } from '@/components/loading/LoadingScreen';
import { newValidUntil } from '@/lib/orgs/lifecycle';

interface OrgUnit {
  id: string;
  name: string;
  domains: string[];
  status: string;
  state: 'ACTIVE' | 'EXPIRING' | 'GRACE' | 'EXPIRED' | 'DISABLED';
  daysLeft: number | null;
  validUntil: string | null;
  locksAt: string | null;
  graceDays: number;
  seatLimit: number | null;
  seatsUsed: number;
  billingNote: string | null;
  members: number;
  mailboxes: number;
}
interface Person { id: string; name: string; email: string; role: string; status: string; orgUnit: { id: string; name: string } | null }
interface Payment { id: string; kind: string; amountMinor: number | null; currency: string; reference: string | null; note: string | null; days: number | null; previousValidUntil: string | null; validUntil: string | null; recordedBy: string | null; createdAt: string }

const STATUS_BADGE: Record<string, string> = { ACTIVE: 'badge-success', PENDING: 'badge-warning', DISABLED: 'badge-neutral' };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');
const dayTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const money = (minor: number | null, cur: string) => (minor === null ? '—' : `${cur === 'INR' ? '₹' : cur + ' '}${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);

/** The badge for an organisation's derived state (lib/orgs/lifecycle.ts), in words an owner understands. */
function stateBadge(o: OrgUnit): { text: string; cls: string } {
  switch (o.state) {
    case 'ACTIVE': return { text: 'Active', cls: 'badge-success' };
    case 'EXPIRING': return { text: o.daysLeft === 0 ? 'Ends today' : `Expiring in ${o.daysLeft} day${o.daysLeft === 1 ? '' : 's'}`, cls: 'badge-warning' };
    case 'GRACE': return { text: 'Expired (grace)', cls: 'badge-danger' };
    case 'EXPIRED': return { text: 'Expired', cls: 'badge-danger' };
    case 'DISABLED': return { text: 'Disabled', cls: 'badge-neutral' };
  }
}

/**
 * Organisations: the teams, customers or brands that use MailFlow. Everyone belongs to exactly one. Here the Super Admin
 * creates them, sets how many people they may have and how long they are valid, records a payment to activate or extend
 * them, and can disable one. After the end date everything but the Dashboard locks; a disabled organisation is locked
 * completely. (Rules: docs/org-lifecycle.md.) Super Admin only.
 */
export default function OrganisationsPage() {
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // create form
  const [name, setName] = useState('');
  const [domains, setDomains] = useState('');
  const [seats, setSeats] = useState('');
  const [validMode, setValidMode] = useState<'none' | 'days' | 'until'>('none');
  const [validDays, setValidDays] = useState('30');
  const [validDate, setValidDate] = useState('');
  const [grace, setGrace] = useState('0');
  const [note, setNote] = useState('');

  // per-organisation edit / dialog / history
  const [editing, setEditing] = useState<{ id: string; name: string; domains: string; seats: string; grace: string; note: string } | null>(null);
  const [dialog, setDialog] = useState<OrgUnit | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [history, setHistory] = useState<Payment[] | null>(null);

  const load = useCallback(async () => {
    const [u, p] = await Promise.all([fetch('/api/admin/org-units', { cache: 'no-store' }).catch(() => null), fetch('/api/admin/users', { cache: 'no-store' }).catch(() => null)]);
    if (!u?.ok || !p?.ok) {
      setError(u?.status === 403 || p?.status === 403 ? 'Only a Super Admin can manage organisations.' : 'Could not load organisations.');
      setLoading(false);
      return;
    }
    setUnits((await u.json()).orgUnits ?? []);
    setPeople(((await p.json()).users ?? []).map((x: Person) => ({ id: x.id, name: x.name, email: x.email, role: x.role, status: x.status, orgUnit: x.orgUnit ?? null })));
    setError(null);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function call(url: string, method: string, body?: unknown, ok?: string) {
    setBusy(url + method);
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    setBusy(null);
    const j = await res?.json().catch(() => ({}));
    if (!res?.ok) { toast.error(j?.error ?? 'That did not work.'); return null; }
    if (ok) toast.success(ok);
    await load();
    return j ?? {};
  }

  async function openHistory(id: string) {
    if (historyOf === id) { setHistoryOf(null); return; }
    setHistoryOf(id);
    setHistory(null);
    const res = await fetch(`/api/admin/org-units/${id}/payments`, { cache: 'no-store' }).catch(() => null);
    setHistory(res?.ok ? (await res.json()).payments : []);
  }

  const shown = useMemo(() => {
    const t = filter.trim().toLowerCase();
    return people.filter((p) => !t || p.name.toLowerCase().includes(t) || p.email.toLowerCase().includes(t) || (p.orgUnit?.name ?? '').toLowerCase().includes(t));
  }, [people, filter]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { name, domains };
    if (seats.trim()) body.seatLimit = Number(seats);
    if (validMode === 'days') body.validDays = Number(validDays);
    if (validMode === 'until') body.validUntil = validDate;
    if (Number(grace) > 0) body.graceDays = Number(grace);
    if (note.trim()) body.billingNote = note.trim();
    if (await call('/api/admin/org-units', 'POST', body, `Created ${name}`)) { setName(''); setDomains(''); setSeats(''); setValidMode('none'); setValidDate(''); setGrace('0'); setNote(''); }
  }

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title="Organisations" description="The teams, customers or brands that use MailFlow. Everyone belongs to one; you choose it when approving a sign-up. Set how many people an organisation may have and how long it is valid, record a payment to activate or extend it, or disable it. After the end date everything except the Dashboard locks." />
      {error && <p className="rounded-lg border border-destructive/40 bg-card p-4 text-sm text-destructive">{error} <button className="underline" onClick={() => void load()}>Try again</button></p>}
      <LoadGate loading={loading} context={['Opening organisations…']}>
        {!error && <>
        <form className="panel mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={create} data-org-create>
          <label className="text-xs font-medium sm:col-span-2">Organisation name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Operations, HR, Tech, Curriculum, a customer" className="input mt-1 w-full" required minLength={2} maxLength={80} />
          </label>
          <label className="text-xs font-medium sm:col-span-2">Sender domains <span className="font-normal text-muted-foreground">(optional)</span>
            <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="masaischool.com, neevlabs.ai" className="input mt-1 w-full" />
          </label>
          <label className="text-xs font-medium">Seats (people allowed) <span className="font-normal text-muted-foreground">(blank = unlimited)</span>
            <input type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} className="input mt-1 w-full" placeholder="e.g. 10" data-create-seats />
          </label>
          <label className="text-xs font-medium">Valid for
            <select value={validMode} onChange={(e) => setValidMode(e.target.value as 'none' | 'days' | 'until')} className="input mt-1 w-full" data-create-valid-mode>
              <option value="none">No end date</option>
              <option value="days">A number of days from today</option>
              <option value="until">Until a date</option>
            </select>
          </label>
          {validMode === 'days' && <label className="text-xs font-medium">Days<input type="number" min={1} max={3650} value={validDays} onChange={(e) => setValidDays(e.target.value)} className="input mt-1 w-full" data-create-days /></label>}
          {validMode === 'until' && <label className="text-xs font-medium">Valid until<input type="date" value={validDate} onChange={(e) => setValidDate(e.target.value)} className="input mt-1 w-full" required /></label>}
          <label className="text-xs font-medium">Grace days after the end <span className="font-normal text-muted-foreground">(0 = lock at once)</span>
            <input type="number" min={0} max={30} value={grace} onChange={(e) => setGrace(e.target.value)} className="input mt-1 w-full" />
          </label>
          <label className="text-xs font-medium sm:col-span-2">Note for yourself <span className="font-normal text-muted-foreground">(customer, plan, contact)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} className="input mt-1 w-full" maxLength={500} />
          </label>
          <div className="flex items-end"><button className="btn-primary" disabled={busy !== null}>Add organisation</button></div>
        </form>

        <div className="mb-6 space-y-3" data-org-list data-org-table>
          {units.map((u) => {
            const b = stateBadge(u);
            const isEditing = editing?.id === u.id;
            const full = u.seatLimit !== null && u.seatsUsed >= u.seatLimit;
            return (
              <section key={u.id} className="panel p-4" data-org-card={u.name}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    {isEditing ? (
                      <input className="input w-64 font-medium" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Organisation name" />
                    ) : (
                      <h2 className="text-base font-semibold">{u.name} <span className={`badge ml-2 align-middle ${b.cls}`} data-org-state>{b.text}</span></h2>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {u.members} {u.members === 1 ? 'person' : 'people'} · {u.mailboxes} connected mailbox{u.mailboxes === 1 ? '' : 'es'} · {u.domains.length ? u.domains.map((d) => `@${d}`).join(', ') : 'any sender domain'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <button className="btn-primary !py-1" onClick={() => setDialog(u)} data-activate>Activate / extend</button>
                    <button
                      className="btn-secondary !py-1"
                      disabled={busy !== null}
                      onClick={async () => {
                        const to = u.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
                        if (to === 'DISABLED' && !confirm(`Disable ${u.name}? Everyone in it is locked out of everything (even the Dashboard) until you enable it again. Nothing is deleted.`)) return;
                        await call(`/api/admin/org-units/${u.id}`, 'PATCH', { status: to }, to === 'ACTIVE' ? `${u.name} is enabled` : `${u.name} is disabled`);
                      }}
                      data-toggle-status
                    >{u.status === 'DISABLED' ? 'Enable' : 'Disable'}</button>
                    <button className="underline" onClick={() => void openHistory(u.id)} data-history>{historyOf === u.id ? 'Hide payments' : 'Payments'}</button>
                    {!isEditing && <button className="underline" onClick={() => setEditing({ id: u.id, name: u.name, domains: u.domains.join(', '), seats: u.seatLimit === null ? '' : String(u.seatLimit), grace: String(u.graceDays), note: u.billingNote ?? '' })} data-edit>Edit</button>}
                    <button
                      className="underline disabled:no-underline disabled:opacity-40"
                      disabled={u.members > 0}
                      title={u.members > 0 ? 'Move its people to another organisation first' : undefined}
                      onClick={async () => { if (confirm(`Delete ${u.name}?`)) await call(`/api/admin/org-units/${u.id}`, 'DELETE', undefined, 'Deleted'); }}
                    >Delete</button>
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-4">
                    <label className="text-xs font-medium sm:col-span-2">Sender domains<input className="input mt-1 w-full" value={editing.domains} onChange={(e) => setEditing({ ...editing, domains: e.target.value })} placeholder="masaischool.com" /></label>
                    <label className="text-xs font-medium">Seats <span className="font-normal text-muted-foreground">(blank = unlimited)</span><input type="number" min={1} className="input mt-1 w-full" value={editing.seats} onChange={(e) => setEditing({ ...editing, seats: e.target.value })} data-edit-seats /></label>
                    <label className="text-xs font-medium">Grace days<input type="number" min={0} max={30} className="input mt-1 w-full" value={editing.grace} onChange={(e) => setEditing({ ...editing, grace: e.target.value })} /></label>
                    <label className="text-xs font-medium sm:col-span-3">Note<input className="input mt-1 w-full" value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} maxLength={500} /></label>
                    <div className="flex items-end gap-2">
                      <button
                        className="btn-primary !py-1 text-xs"
                        disabled={busy !== null}
                        data-edit-save
                        onClick={async () => {
                          const r = await call(`/api/admin/org-units/${u.id}`, 'PATCH', { name: editing.name, domains: editing.domains, seatLimit: editing.seats.trim() ? Number(editing.seats) : null, graceDays: Number(editing.grace) || 0, billingNote: editing.note.trim() || null }, 'Saved');
                          if (r) setEditing(null);
                        }}
                      >Save</button>
                      <button className="btn-secondary !py-1 text-xs" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Seats</dt>
                      <dd data-org-seats className={full ? 'font-medium text-amber-700 dark:text-amber-400' : ''}>{u.seatsUsed} / {u.seatLimit === null ? 'unlimited' : u.seatLimit}{full ? ' · full' : ''}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Valid until</dt>
                      <dd data-org-valid>
                        {u.validUntil ? <>{day(u.validUntil)} <span className="text-xs text-muted-foreground">({u.daysLeft !== null && u.daysLeft >= 0 ? (u.daysLeft === 0 ? 'ends today' : `${u.daysLeft} day${u.daysLeft === 1 ? '' : 's'} left`) : `ended ${Math.abs(u.daysLeft ?? 0)} day${Math.abs(u.daysLeft ?? 0) === 1 ? '' : 's'} ago`})</span></> : <span className="text-muted-foreground">No end date</span>}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">After the end date</dt>
                      <dd className="text-xs text-muted-foreground">{u.graceDays > 0 ? `${u.graceDays} grace day${u.graceDays === 1 ? '' : 's'}, then ` : ''}only the Dashboard stays open</dd>
                    </div>
                    {u.billingNote && <div className="sm:col-span-3 text-xs text-muted-foreground">Note: {u.billingNote}</div>}
                  </dl>
                )}

                {historyOf === u.id && (
                  <div className="mt-3 overflow-x-auto rounded border border-border-subtle" data-payments>
                    {history === null ? <p className="p-3 text-xs text-muted-foreground">Loading…</p> : history.length === 0 ? <p className="p-3 text-xs text-muted-foreground">No payments recorded yet.</p> : (
                      <table className="w-full text-xs">
                        <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground"><tr><th className="px-3 py-1.5">Recorded</th><th className="px-3 py-1.5">Type</th><th className="px-3 py-1.5">Amount</th><th className="px-3 py-1.5">Reference</th><th className="px-3 py-1.5 text-right">Days</th><th className="px-3 py-1.5">Valid until</th><th className="px-3 py-1.5">By</th></tr></thead>
                        <tbody>
                          {history.map((p) => (
                            <tr key={p.id} className="border-t border-border-subtle align-top">
                              <td className="px-3 py-1.5 whitespace-nowrap">{dayTime(p.createdAt)}</td>
                              <td className="px-3 py-1.5">{p.kind === 'ACTIVATE' ? 'Activated' : p.kind === 'EXTEND' ? 'Extended' : 'Adjusted'}</td>
                              <td className="px-3 py-1.5">{money(p.amountMinor, p.currency)}</td>
                              <td className="px-3 py-1.5">{p.reference ?? '—'}{p.note && <div className="text-muted-foreground">{p.note}</div>}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{p.days ?? '—'}</td>
                              <td className="px-3 py-1.5 whitespace-nowrap">{day(p.validUntil)}{p.previousValidUntil && <div className="text-muted-foreground">was {day(p.previousValidUntil)}</div>}</td>
                              <td className="px-3 py-1.5">{p.recordedBy ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </section>
            );
          })}
          {units.length === 0 && <p className="panel p-6 text-center text-sm text-muted-foreground">No organisations yet. Add the first one above.</p>}
        </div>

        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">People ({people.length})</h2>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search name, email or organisation…" className="input !py-1 text-sm sm:w-72" />
        </div>
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm" data-org-people>
            <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-4 py-2">Person</th><th className="px-4 py-2">Role</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Organisation</th></tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className="border-t border-border-subtle">
                  <td className="px-4 py-2"><div className="font-medium">{p.name}</div><div className="text-xs text-muted-foreground">{p.email}</div></td>
                  <td className="px-4 py-2 text-xs">{p.role.toLowerCase().replace('_', ' ')}</td>
                  <td className="px-4 py-2"><span className={`badge ${STATUS_BADGE[p.status] ?? 'badge-neutral'}`}>{p.status.toLowerCase()}</span></td>
                  <td className="px-4 py-2">
                    <select
                      aria-label={`Organisation of ${p.name}`}
                      className="input !py-1 text-sm"
                      value={p.orgUnit?.id ?? ''}
                      disabled={busy !== null}
                      onChange={async (e) => {
                        const to = units.find((u) => u.id === e.target.value);
                        if (!to) return;
                        if (p.orgUnit && !confirm(`Move ${p.name} from ${p.orgUnit.name} to ${to.name}? Their new sends use ${to.name}’s mailboxes; sends already made stay as they were.`)) return;
                        await call(`/api/admin/users/${p.id}`, 'PATCH', { orgUnitId: to.id }, `${p.name} is now in ${to.name}`);
                      }}
                    >
                      {!p.orgUnit && <option value="">Not assigned</option>}
                      {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>}
      </LoadGate>

      {dialog && (
        <ActivateDialog
          org={dialog}
          busy={busy !== null}
          onClose={() => setDialog(null)}
          onSave={async (body) => {
            const r = await call(`/api/admin/org-units/${dialog.id}/activate`, 'POST', body, `${dialog.name} is valid until ${day(r_until(body, dialog))}`);
            if (r) { setDialog(null); if (historyOf === dialog.id) { setHistoryOf(null); void openHistory(dialog.id); } }
          }}
        />
      )}
    </div>
  );
}

type ActivateBody = { mode: 'days'; days: number; amountMinor?: number; currency: string; reference?: string; note?: string } | { mode: 'until'; until: string; amountMinor?: number; currency: string; reference?: string; note?: string };

/** The end date a body would give (for the confirmation message). */
function r_until(body: ActivateBody, org: OrgUnit): string | null {
  const d = body.mode === 'days' ? newValidUntil({ mode: 'days', days: body.days }, org.validUntil ? new Date(org.validUntil) : null) : newValidUntil({ mode: 'until', until: body.until }, null);
  return d ? d.toISOString() : null;
}

/** "Activate / extend": the payment has arrived. Add days (from today, or from the current end date when later) or set an end date. */
function ActivateDialog({ org, busy, onClose, onSave }: { org: OrgUnit; busy: boolean; onClose: () => void; onSave: (body: ActivateBody) => Promise<void> }) {
  const [mode, setMode] = useState<'days' | 'until'>('days');
  const [days, setDays] = useState('30');
  const [until, setUntil] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  const current = org.validUntil ? new Date(org.validUntil) : null;
  const result = mode === 'days' ? newValidUntil({ mode: 'days', days: Number(days) }, current) : until ? newValidUntil({ mode: 'until', until }, null) : null;
  const startsFrom = current && current.getTime() > Date.now() ? `the current end date (${day(org.validUntil)})` : 'today';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={`Activate or extend ${org.name}`} data-activate-dialog>
      <form
        className="panel max-h-[90vh] w-full max-w-lg overflow-y-auto p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!result) return;
          const minor = amount.trim() ? Math.round(Number(amount) * 100) : undefined;
          const common = { amountMinor: minor, currency, reference: reference.trim() || undefined, note: note.trim() || undefined };
          await onSave(mode === 'days' ? { mode, days: Number(days), ...common } : { mode, until, ...common });
        }}
      >
        <h3 className="mb-1 text-base font-semibold">Activate / extend {org.name}</h3>
        <p className="mb-4 text-xs text-muted-foreground">Use this when the payment has arrived. {org.validUntil ? `It is valid until ${day(org.validUntil)} now.` : 'It has no end date now.'}</p>

        <div className="mb-3 flex rounded-full border border-border p-0.5 text-xs" role="tablist">
          {(['days', 'until'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`flex-1 rounded-full px-3 py-1 font-medium ${mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{m === 'days' ? 'Add days' : 'Valid until a date'}</button>
          ))}
        </div>

        {mode === 'days' ? (
          <div className="mb-3">
            <div className="mb-2 flex flex-wrap gap-2">
              {[30, 90, 180, 365].map((n) => <button key={n} type="button" onClick={() => setDays(String(n))} className={`rounded-full border px-3 py-1 text-xs ${Number(days) === n ? 'border-primary text-primary' : 'border-border'}`} data-quick-days={n}>{n} days</button>)}
            </div>
            <label className="text-xs font-medium">Days to add<input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className="input mt-1 w-full" data-days-input /></label>
            <p className="mt-1 text-[11px] text-muted-foreground">Counted from {startsFrom}, so renewing early loses nothing.</p>
          </div>
        ) : (
          <label className="mb-3 block text-xs font-medium">Valid until<input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="input mt-1 w-full" data-until-input /></label>
        )}

        <div className="mb-3 rounded border border-primary/30 bg-primary/5 p-2 text-sm" data-result>
          {result ? <>New end date: <b>{day(result.toISOString())}</b> (to the end of that day, India time)</> : <span className="text-muted-foreground">{mode === 'days' ? 'Enter a number of days from 1 to 3650.' : 'Choose a date in the future.'}</span>}
        </div>

        <div className="mb-3 grid grid-cols-3 gap-3">
          <label className="col-span-2 text-xs font-medium">Amount received <span className="font-normal text-muted-foreground">(optional)</span><input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="input mt-1 w-full" placeholder="e.g. 25000" /></label>
          <label className="text-xs font-medium">Currency<select value={currency} onChange={(e) => setCurrency(e.target.value)} className="input mt-1 w-full"><option>INR</option><option>USD</option><option>EUR</option><option>GBP</option></select></label>
          <label className="col-span-3 text-xs font-medium">Reference <span className="font-normal text-muted-foreground">(transaction id / invoice number, optional)</span><input value={reference} onChange={(e) => setReference(e.target.value)} className="input mt-1 w-full" maxLength={120} /></label>
          <label className="col-span-3 text-xs font-medium">Note <span className="font-normal text-muted-foreground">(optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} className="input mt-1 w-full" maxLength={500} /></label>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!result || busy} data-activate-save>Save and activate</button>
        </div>
      </form>
    </div>
  );
}
