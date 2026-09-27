'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { INTENT_TAGS, type OrgSettings } from '@/lib/settings/org-schema';

interface Loaded {
  settings: OrgSettings;
  mailboxes: { id: string; emailAddress: string; ownerName: string | null }[];
  users: { id: string; name: string | null; email: string; role: string }[];
  intents: (keyof typeof INTENT_TAGS)[];
}

type Patch = Record<string, unknown>;

function Toggle({ checked, disabled, onChange, label, hint }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex items-start gap-2 rounded-md border border-border-subtle p-3 text-xs">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function EmailList({ value, disabled, onSave, label }: { value: string[]; disabled: boolean; onSave: (v: string[]) => void; label: string }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value]);
  const parsed = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const changed = parsed.join(',') !== value.join(',');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-[260px] flex-1 text-xs">
        <span className="mb-1 block font-medium">{label}</span>
        <input value={text} onChange={(e) => setText(e.target.value)} disabled={disabled} placeholder="name@masaischool.com, other@masaischool.com" className="w-full text-sm" />
      </label>
      <button onClick={() => onSave(parsed)} disabled={disabled || !changed} className="btn-secondary !py-1.5 text-xs">Save</button>
    </div>
  );
}

/** Daily digest, weekly report and AI inbox triage settings (Super Admin). */
export function AutomationSettings({ readOnly }: { readOnly: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/automation-settings');
    if (!res.ok) return toast.error('Could not load automation settings');
    setData(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: Patch) {
    setBusy('save');
    const res = await fetch('/api/admin/automation-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const j = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return toast.error(j.error ?? j.issues?.[0]?.message ?? 'Could not save');
    setData(j);
    toast.success('Saved');
  }

  async function run(action: 'preview-digest' | 'preview-report' | 'test-digest' | 'test-report') {
    setBusy(action);
    const res = await fetch('/api/admin/automation-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    const j = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return toast.error(j.error ?? 'Request failed');
    if (action.startsWith('preview')) setPreview({ subject: j.subject, html: j.html });
    else if (j.ok) toast.success(`Test sent: ${j.outcome}`);
    else toast.error(j.outcome ?? 'Could not send the test');
  }

  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const s = data.settings;
  const off = readOnly || busy !== null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <span className="mb-1 block font-medium">Send digests and reports from</span>
          <select value={s.senderAccountId ?? ''} disabled={off} onChange={(e) => save({ senderAccountId: e.target.value || null })} className="min-w-[280px] text-sm">
            <option value="">Oldest connected mailbox (automatic)</option>
            {data.mailboxes.map((m) => (
              <option key={m.id} value={m.id}>{m.emailAddress}{m.ownerName ? ` · ${m.ownerName}` : ''}</option>
            ))}
          </select>
        </label>
        {data.mailboxes.length === 0 && <p className="text-xs text-warning">No connected Gmail mailbox yet: emails can&apos;t be sent until someone connects Gmail in Settings.</p>}
      </div>

      {/* Daily digest */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Daily “needs attention” digest</h3>
            <p className="text-xs text-muted-foreground">Every day at 09:00 IST: unanswered replies, SLA breaches, documents about to expire unsigned, and pending approvals. Skipped on days with nothing to report.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => run('preview-digest')} disabled={busy !== null} className="btn-secondary !py-1.5 text-xs">{busy === 'preview-digest' ? 'Loading…' : 'Preview today'}</button>
            <button onClick={() => run('test-digest')} disabled={busy !== null} className="btn-secondary !py-1.5 text-xs">{busy === 'test-digest' ? 'Sending…' : 'Send test to me'}</button>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Toggle checked={s.digest.enabled} disabled={off} onChange={(v) => save({ digest: { enabled: v } })} label="Send the digest" hint="Turn the daily email and Slack post on or off." />
          <Toggle checked={s.digest.emailAdmins} disabled={off || !s.digest.enabled} onChange={(v) => save({ digest: { emailAdmins: v } })} label="Email all admins" hint="Every Super Admin and Admin in the organisation." />
          <Toggle checked={s.digest.slack} disabled={off || !s.digest.enabled} onChange={(v) => save({ digest: { slack: v } })} label="Post to Slack" hint="A short summary in the notifications channel." />
        </div>
        <EmailList label="Also email" value={s.digest.extraEmails} disabled={off || !s.digest.enabled} onSave={(v) => save({ digest: { extraEmails: v } })} />
        <div className="flex flex-wrap gap-4 text-xs">
          <label>
            <span className="mb-1 block font-medium">“Expiring” means within</span>
            <select value={s.digest.expiringWithinHours} disabled={off} onChange={(e) => save({ digest: { expiringWithinHours: Number(e.target.value) } })} className="text-sm">
              {[24, 48, 72, 120].map((h) => <option key={h} value={h}>{h} hours</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block font-medium">“Unanswered” means no reply for</span>
            <select value={s.digest.unansweredAfterHours} disabled={off} onChange={(e) => save({ digest: { unansweredAfterHours: Number(e.target.value) } })} className="text-sm">
              {[12, 24, 48, 72].map((h) => <option key={h} value={h}>{h} hours</option>)}
            </select>
          </label>
        </div>
      </div>

      {/* Weekly report */}
      <div className="space-y-3 border-t border-border-subtle pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Weekly leadership report</h3>
            <p className="text-xs text-muted-foreground">Mondays at 09:00 IST: campaigns, e-signature and inbox response times for the last 7 days, compared with the week before.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => run('preview-report')} disabled={busy !== null} className="btn-secondary !py-1.5 text-xs">{busy === 'preview-report' ? 'Loading…' : 'Preview this week'}</button>
            <button onClick={() => run('test-report')} disabled={busy !== null} className="btn-secondary !py-1.5 text-xs">{busy === 'test-report' ? 'Sending…' : 'Send test to me'}</button>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Toggle checked={s.weeklyReport.enabled} disabled={off} onChange={(v) => save({ weeklyReport: { enabled: v } })} label="Send the weekly report" hint="Turn the Monday email on or off." />
          <Toggle checked={s.weeklyReport.emailSuperAdmins} disabled={off || !s.weeklyReport.enabled} onChange={(v) => save({ weeklyReport: { emailSuperAdmins: v } })} label="Email Super Admins" hint="Every Super Admin in the organisation." />
          <Toggle checked={s.weeklyReport.slack} disabled={off || !s.weeklyReport.enabled} onChange={(v) => save({ weeklyReport: { slack: v } })} label="Post to Slack" hint="Headline numbers in the notifications channel." />
        </div>
        <EmailList label="Leadership emails (also receive it)" value={s.weeklyReport.extraEmails} disabled={off || !s.weeklyReport.enabled} onSave={(v) => save({ weeklyReport: { extraEmails: v } })} />
      </div>

      {/* AI triage */}
      <div className="space-y-3 border-t border-border-subtle pt-5">
        <div>
          <h3 className="text-sm font-semibold">AI inbox triage</h3>
          <p className="text-xs text-muted-foreground">When a student replies, the AI reads the intent and can tag it, assign it, draft an answer for someone to approve, and close simple “thank you” replies. Nothing is ever sent without a person clicking Send.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle checked={s.triage.enabled} disabled={off} onChange={(v) => save({ triage: { enabled: v } })} label="Triage new replies" hint="Master switch for everything below." />
          <Toggle checked={s.triage.autoTag} disabled={off || !s.triage.enabled} onChange={(v) => save({ triage: { autoTag: v } })} label="Tag by intent" hint="Question, Request, Complaint, Needs action, Completed, Thanks." />
          <Toggle checked={s.triage.draftReplies} disabled={off || !s.triage.enabled} onChange={(v) => save({ triage: { draftReplies: v } })} label="Draft replies" hint="Questions, requests and complaints get an AI draft, approved with one click." />
          <Toggle checked={s.triage.autoResolveAcknowledgements} disabled={off || !s.triage.enabled} onChange={(v) => save({ triage: { autoResolveAcknowledgements: v } })} label="Close “thank you” replies" hint={`Only when the AI is at least ${Math.round(s.triage.autoResolveMinConfidence * 100)}% sure. A new reply reopens it.`} />
          <Toggle checked={s.triage.autoAssign} disabled={off || !s.triage.enabled} onChange={(v) => save({ triage: { autoAssign: v } })} label="Assign unassigned replies" hint="To the person chosen below for that intent, otherwise to the conversation owner." />
        </div>
        {s.triage.enabled && s.triage.autoAssign && (
          <div className="grid gap-2 sm:grid-cols-3">
            {data.intents.map((intent) => (
              <label key={intent} className="text-xs">
                <span className="mb-1 block font-medium">{INTENT_TAGS[intent]} →</span>
                <select
                  value={s.triage.assignByIntent[intent] ?? ''}
                  disabled={off}
                  onChange={(e) => save({ triage: { assignByIntent: { ...s.triage.assignByIntent, [intent]: e.target.value } } })}
                  className="w-full text-sm"
                >
                  <option value="">Conversation owner</option>
                  {data.users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name ?? u.email}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 sm:p-6" onClick={() => setPreview(null)}>
          <div className="panel flex w-full max-w-3xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Email preview">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
              <div className="min-w-0">
                <div className="eyebrow">Preview · nothing is sent</div>
                <div className="truncate text-sm font-semibold">{preview.subject}</div>
              </div>
              <button onClick={() => setPreview(null)} className="btn-secondary !py-1.5 text-xs">Close</button>
            </div>
            <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="min-h-[60vh] w-full flex-1 bg-white" />
          </div>
        </div>
      )}
    </div>
  );
}
