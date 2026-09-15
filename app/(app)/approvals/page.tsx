'use client';

import { Fragment, Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

interface RequestRow {
  id: string;
  name: string;
  status: string;
  workspace: { id: string; name: string };
  requester: { id: string; name: string; email: string };
  dataset: string;
  recipients: number;
  template: string;
  subjectLine: string;
  submittedAt: string | null;
  decidedAt: string | null;
  reviewer: string | null;
  reason: string | null;
  remarks: string | null;
  requestEmail: string | null;
  decisionEmail: string | null;
  canDecide: boolean;
  isOwn: boolean;
}

type Tab = 'pending' | 'approved' | 'rejected' | 'all';
type Section = 'campaigns' | 'users';

interface PendingUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: string;
}

const STATUS_BADGE: Record<string, string> = {
  PENDING_APPROVAL: 'badge-warning',
  APPROVED: 'badge-success',
  REJECTED: 'badge-danger',
  COMPLETED: 'badge-success',
  RUNNING: 'badge-info',
  PARTIALLY_FAILED: 'badge-warning',
};

function ago(iso: string | null) {
  if (!iso) return '—';
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

export default function ApprovalsPage() {
  return <Suspense><ApprovalsPageInner /></Suspense>;
}

function ApprovalsPageInner() {
  const searchParams = useSearchParams();
  const [section, setSection] = useState<Section>(
    searchParams.get('section') === 'users' ? 'users' : 'campaigns'
  );
  const [tab, setTab] = useState<Tab>('pending');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 });
  const [scope, setScope] = useState<'organization' | 'workspace'>('workspace');
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [decision, setDecision] = useState<{ row: RequestRow; action: 'APPROVE' | 'REJECT' } | null>(null);
  const [reason, setReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // User registrations state
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userBusy, setUserBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/approvals?status=${tab}&q=${encodeURIComponent(q.trim())}`);
    if (res.status === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    const json = await res.json();
    setRows(json.requests ?? []);
    setCounts(json.counts ?? counts);
    setScope(json.scope ?? 'workspace');
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    const res = await fetch('/api/admin/pending-users');
    if (res.ok) {
      const json = await res.json();
      setPendingUsers(json.users ?? []);
    }
    setUsersLoading(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // Always load pending users count so the badge on the tab stays accurate.
  useEffect(() => { loadUsers(); }, [loadUsers]);
  useEffect(() => {
    if (section === 'users') loadUsers();
  }, [section, loadUsers]);

  async function approveUser(id: string) {
    setUserBusy(id);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    setUserBusy(null);
    if (!res.ok) { toast.error('Could not approve user'); return; }
    toast.success('User approved — they can now sign in');
    loadUsers();
  }

  async function rejectUser(id: string, name: string) {
    if (!confirm(`Reject and disable ${name}? They will not be able to sign in.`)) return;
    setUserBusy(id);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'DISABLED' }),
    });
    setUserBusy(null);
    if (!res.ok) { toast.error('Could not reject user'); return; }
    toast.success('User rejected and disabled');
    loadUsers();
  }

  async function decide() {
    if (!decision) return;
    if (decision.action === 'REJECT' && !reason.trim()) {
      toast.error('A reason is required — the requester will see it.');
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/campaigns/${decision.row.id}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: decision.action, reason: reason.trim() || undefined, remarks: remarks.trim() || undefined }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast.error(json.error ?? 'Could not record the decision');
      return;
    }
    const emailNote = json.emailStatus ? ` · email ${String(json.emailStatus).toLowerCase().startsWith('sent') ? 'sent in the request thread' : json.emailStatus}` : '';
    toast.success(`${decision.action === 'APPROVE' ? 'Approved' : 'Rejected'} "${decision.row.name}"${emailNote}`, { duration: 8000 });
    setDecision(null);
    setReason('');
    setRemarks('');
    load();
  }

  if (forbidden) {
    return (
      <div className="p-6">
        <h1 className="font-heading text-2xl font-bold tracking-tight">Approvals</h1>
        <p className="mt-2 text-sm text-muted-foreground">Only admins can review campaign requests.</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      {/* Section switcher */}
      <div className="mb-5 flex items-center gap-1 rounded-lg border border-border bg-card p-1 w-fit">
        {(['campaigns', 'users'] as Section[]).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              section === s ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-elevated hover:text-foreground'
            }`}
          >
            {s === 'campaigns' ? 'Campaign Approvals' : (
              <span className="flex items-center gap-2">
                User Registrations
                {pendingUsers.length > 0 && section !== 'users' && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold leading-4 text-primary-foreground">{pendingUsers.length}</span>
                )}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── User Registrations ── */}
      {section === 'users' && (
        <div>
          <div className="mb-4">
            <h1 className="font-heading text-2xl font-bold tracking-tight">User Registrations</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              New accounts waiting for approval. Approved users get full access; rejected users are disabled.
            </p>
          </div>
          {usersLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : pendingUsers.length === 0 ? (
            <div className="panel px-4 py-10 text-center text-sm text-muted-foreground">
              No pending registrations — all users are approved.
            </div>
          ) : (
            <div className="panel overflow-hidden">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground bg-muted">
                  <tr>
                    <th className="px-4 py-2">Name</th>
                    <th className="px-4 py-2">Email</th>
                    <th className="px-4 py-2">Requested</th>
                    <th className="px-4 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingUsers.map((u) => (
                    <tr key={u.id} className="border-t border-border-subtle">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {u.image && <img src={u.image} alt="" className="h-7 w-7 rounded-full" />}
                          <span className="font-medium">{u.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {new Date(u.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            disabled={userBusy === u.id}
                            onClick={() => approveUser(u.id)}
                            className="btn-primary !py-1 text-[11px]"
                          >
                            {userBusy === u.id ? 'Saving…' : 'Approve'}
                          </button>
                          <button
                            disabled={userBusy === u.id}
                            onClick={() => rejectUser(u.id, u.name)}
                            className="btn-secondary !py-1 text-[11px]"
                          >
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Campaign Approvals ── */}
      {section === 'campaigns' && (<>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow mb-2">{scope === 'organization' ? 'Organisation' : 'Workspace'}</div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">Approvals</h1>
          <p className="mt-1 text-sm text-muted-foreground">Campaigns waiting for a decision. Nothing is sent until it is approved here or on the campaign page.</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ['pending', 'Pending', counts.pending, 'text-warning'],
              ['approved', 'Approved', counts.approved, 'text-success'],
              ['rejected', 'Rejected', counts.rejected, 'text-primary'],
            ] as const
          ).map(([key, label, value, tone]) => (
            <button key={key} onClick={() => setTab(key)} className={`panel px-3 py-2 text-left ${tab === key ? '!border-primary' : ''}`}>
              <div className={`font-heading text-xl font-bold ${tone}`}>{value}</div>
              <div className="text-[11px] text-muted-foreground">{label}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-full border border-border bg-card p-1">
          {(['pending', 'approved', 'rejected', 'all'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {t}
            </button>
          ))}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search campaign, requester, workspace…" className="w-full !py-1.5 text-sm sm:w-72" />
      </div>

      <div className="panel overflow-hidden">
        {loading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{tab === 'pending' ? 'Nothing is waiting for approval.' : 'No requests match.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Campaign</th>
                  <th className="px-4 py-2">Requester</th>
                  <th className="hidden px-4 py-2 md:table-cell">Recipients</th>
                  <th className="hidden px-4 py-2 lg:table-cell">Template</th>
                  <th className="px-4 py-2">{tab === 'pending' ? 'Waiting' : 'Decided'}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="border-t border-border-subtle align-top">
                      <td className="px-4 py-3">
                        <Link href={`/campaigns/${r.id}`} className="font-medium hover:text-primary">{r.name}</Link>
                        <div className="text-xs text-faint">
                          <span className={`badge ${STATUS_BADGE[r.status] ?? 'badge-neutral'} mr-2`}>{r.status.replace(/_/g, ' ').toLowerCase()}</span>
                          {r.workspace.name} · {r.dataset}
                        </div>
                        <button onClick={() => setExpanded(expanded === r.id ? null : r.id)} className="mt-1 text-[11px] text-muted-foreground hover:text-foreground">
                          {expanded === r.id ? 'Hide details' : 'Details'}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div>{r.requester.name}</div>
                        <div className="text-xs text-faint">{r.requester.email}</div>
                      </td>
                      <td className="hidden px-4 py-3 tabular-nums md:table-cell">{r.recipients}</td>
                      <td className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">
                        <div>{r.template}</div>
                        <div className="truncate text-faint" title={r.subjectLine}>{r.subjectLine}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {tab === 'pending' ? (
                          <span title={r.submittedAt ?? ''}>{ago(r.submittedAt)}</span>
                        ) : (
                          <>
                            <div>{r.decidedAt ? new Date(r.decidedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</div>
                            {r.reviewer && <div className="text-faint">by {r.reviewer}</div>}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {r.status === 'PENDING_APPROVAL' ? (
                          r.canDecide ? (
                            <div className="flex justify-end gap-1.5">
                              <button onClick={() => setDecision({ row: r, action: 'APPROVE' })} className="btn-primary !py-1 text-[11px]">Approve</button>
                              <button onClick={() => setDecision({ row: r, action: 'REJECT' })} className="btn-secondary !py-1 text-[11px]">Reject</button>
                            </div>
                          ) : (
                            <span className="text-[11px] text-faint">Your own request</span>
                          )
                        ) : (
                          <Link href={`/campaigns/${r.id}`} className="text-xs text-muted-foreground hover:text-primary">Open</Link>
                        )}
                      </td>
                    </tr>
                    {expanded === r.id && (
                      <tr className="bg-elevated/40">
                        <td colSpan={6} className="px-4 py-3 text-xs">
                          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                            <div><dt className="text-faint">Submitted</dt><dd>{r.submittedAt ? new Date(r.submittedAt).toLocaleString('en-IN') : '—'}</dd></div>
                            <div><dt className="text-faint">Template</dt><dd>{r.template}</dd></div>
                            <div><dt className="text-faint">Subject line</dt><dd>{r.subjectLine}</dd></div>
                            <div><dt className="text-faint">Request email</dt><dd>{r.requestEmail ?? 'not sent yet'}</dd></div>
                            <div><dt className="text-faint">Decision email</dt><dd>{r.decisionEmail ?? '—'}</dd></div>
                            {r.reason && <div><dt className="text-faint">Reason (sent to requester)</dt><dd className="text-primary">{r.reason}</dd></div>}
                            {r.remarks && <div><dt className="text-faint">Remarks (internal)</dt><dd>{r.remarks}</dd></div>}
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {decision && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={() => !busy && setDecision(null)}>
          <div className="panel w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
            <div className="eyebrow mb-2">{decision.action === 'APPROVE' ? 'Approve' : 'Reject'}</div>
            <h2 className="font-heading text-lg font-bold">{decision.row.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {decision.row.recipients} recipient(s) · requested by {decision.row.requester.name}. The requester is emailed in the same thread as their request.
            </p>
            {decision.action === 'REJECT' && (
              <label className="mt-4 block text-xs">
                <span className="font-medium">Reason <span className="text-primary">*</span> <span className="text-faint">— sent to the requester</span></span>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="mt-1 w-full text-sm" placeholder="What needs to change before this can go out?" />
              </label>
            )}
            <label className="mt-3 block text-xs">
              <span className="font-medium">Remarks <span className="text-faint">— internal, visible to reviewers only</span></span>
              <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} className="mt-1 w-full text-sm" placeholder="Optional notes for the audit trail" />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setDecision(null)} disabled={busy} className="btn-secondary">Cancel</button>
              <button onClick={decide} disabled={busy} className="btn-primary">
                {busy ? 'Saving…' : decision.action === 'APPROVE' ? 'Approve campaign' : 'Reject campaign'}
              </button>
            </div>
          </div>
        </div>
      )}
      </>)} {/* end campaigns section */}
    </div>
  );
}
