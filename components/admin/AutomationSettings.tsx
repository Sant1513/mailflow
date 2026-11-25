'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { INTENT_TAGS, RECRUITER_REPEAT_MAX_DAYS, RECRUITER_REPEAT_SHORT_DAYS, type OrgSettings } from '@/lib/settings/org-schema';
import { SlackPreview } from '@/components/admin/SlackPreview';

type SlackPayload = { text: string; blocks: { type: string }[]; channel: string | null; as: { username: string; iconEmoji: string } };
type Action = 'preview-digest' | 'preview-report' | 'test-digest' | 'test-report' | 'test-slack-digest' | 'test-slack-report';

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

/** A Slack channel ID (e.g. C09FEU43FK8); empty = the notifications channel from System Settings. */
function ChannelField({ value, disabled, onSave, label }: { value: string; disabled: boolean; onSave: (v: string) => void; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const clean = text.trim().toUpperCase();
  const valid = clean === '' || /^[CGD][A-Z0-9]{6,20}$/.test(clean);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs">
        <span className="mb-1 block font-medium">{label}</span>
        <input value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} placeholder="e.g. C09FEU43FK8 (empty = notifications channel)" className="w-72 font-mono text-sm" />
      </label>
      <button onClick={() => onSave(clean)} disabled={disabled || !valid || clean === value} className="btn-secondary !py-1.5 text-xs">Save channel</button>
      {!valid && <span className="text-xs text-warning">A channel ID starts with C, G or D (Slack → channel → About → Channel ID).</span>}
    </div>
  );
}

/** Default repeat window for Recruiter Bulk Send; the warning follows the typed value. */
function RepeatWindow({ value, disabled, onSave }: { value: number; disabled: boolean; onSave: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const n = text.trim() === '' ? NaN : Number(text);
  const valid = Number.isInteger(n) && n >= 0 && n <= RECRUITER_REPEAT_MAX_DAYS;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <span className="mb-1 block font-medium">Skip recruiters emailed in the last</span>
          <span className="flex items-center gap-2">
            <input type="number" min={0} max={RECRUITER_REPEAT_MAX_DAYS} step={1} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} className="w-24 text-sm" />
            <span>days</span>
          </span>
        </label>
        <button onClick={() => onSave(n)} disabled={disabled || !valid || n === value} className="btn-secondary !py-1.5 text-xs">Save</button>
        {!valid && <span className="text-xs text-warning">Enter a whole number from 0 to {RECRUITER_REPEAT_MAX_DAYS}.</span>}
      </div>
      <p className="text-xs text-muted-foreground">0 = never skip; max {RECRUITER_REPEAT_MAX_DAYS}. Applies to new sends. Each send can still change it. Campaigns, Quick Send and Inbox replies count as emailing.</p>
      {valid && n === 0 && <p className="text-xs text-amber-600">The repeat check is off: nobody is skipped for being emailed recently.</p>}
      {valid && n >= 1 && n < RECRUITER_REPEAT_SHORT_DAYS && <p className="text-xs text-amber-600">Under {RECRUITER_REPEAT_SHORT_DAYS} days: recruiters may feel over-mailed, and a few days is often not enough for a reply.</p>}
    </div>
  );
}

/** Daily digest, weekly report and AI inbox triage settings (Super Admin). */
export function AutomationSettings({ readOnly }: { readOnly: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string; slack?: SlackPayload } | null>(null);
  const [tab, setTab] = useState<'email' | 'slack'>('email');

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

  async function run(action: Action) {
    setBusy(action);
    const res = await fetch('/api/admin/automation-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    const j = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return toast.error(j.error ?? 'Request failed');
    if (action.startsWith('preview')) {
      setTab('email');
      setPreview({ subject: j.subject, html: j.html, slack: j.slack });
    }
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
            <h3 className="text-sm font-semibold">Daily report</h3>
            <p className="text-xs text-muted-foreground">8 PM IST, Monday to Friday: everything sent since the last report (8 PM to 8 PM) by type, user and mailbox, each person&apos;s inbox (received, pending, closed, FRT, ART), and what needs attention. Work after 8 PM goes into the next report; the weekend goes into Monday&apos;s, marked as such.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => run('preview-digest')} disabled={busy !== null} className="btn-secondary !py-1.5 text-xs">{busy === 'preview-digest' ? 'Loading…' : 'Preview latest'}</button>
            <button onClick={() => run('test-digest')} disabled={busy !== null} className="btn-secondary !py-1.5 text-xs">{busy === 'test-digest' ? 'Sending…' : 'Send test to me'}</button>
            <button onClick={() => run('test-slack-digest')} disabled={busy !== null || !s.digest.slack} className="btn-secondary !py-1.5 text-xs">{busy === 'test-slack-digest' ? 'Posting…' : 'Send test to Slack'}</button>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Toggle checked={s.digest.enabled} disabled={off} onChange={(v) => save({ digest: { enabled: v } })} label="Send the daily report" hint="Turn the 8 PM email and Slack post on or off." />
          <Toggle checked={s.digest.emailAdmins} disabled={off || !s.digest.enabled || (s.digest.to ?? []).length > 0} onChange={(v) => save({ digest: { emailAdmins: v } })} label="Email all admins (Bcc)" hint="Used only when no To address is set below." />
          <Toggle checked={s.digest.slack} disabled={off || !s.digest.enabled} onChange={(v) => save({ digest: { slack: v } })} label="Post to Slack" hint="The same report in Slack, at the same time, as “MailFlow Daily Report”." />
        </div>
        <EmailList label="To (one visible email, no Bcc)" value={s.digest.to ?? []} disabled={off || !s.digest.enabled} onSave={(v) => save({ digest: { to: v } })} />
        <EmailList label="CC" value={s.digest.cc ?? []} disabled={off || !s.digest.enabled || !(s.digest.to ?? []).length} onSave={(v) => save({ digest: { cc: v } })} />
        <ChannelField label="Slack channel for the daily report" value={s.digest.slackChannel ?? ''} disabled={off || !s.digest.enabled || !s.digest.slack} onSave={(v) => save({ digest: { slackChannel: v } })} />
        {!(s.digest.to ?? []).length && <EmailList label="Also email (Bcc)" value={s.digest.extraEmails} disabled={off || !s.digest.enabled} onSave={(v) => save({ digest: { extraEmails: v } })} />}
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
            <h3 className="text-sm font-semibold">Weekly report</h3>
            <p className="text-xs text-muted-foreground">Mondays at 09:00 IST, in the same design as the daily report: last week Monday to Sunday, day by day, by user and mailbox, each person&apos;s inbox, compared with the week before.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => run('preview-report')} disabled={busy !== null} className="btn-secondary !py-1.5 text-xs">{busy === 'preview-report' ? 'Loading…' : 'Preview last week'}</button>
            <button onClick={() => run('test-report')} disabled={busy !== null} className="btn-secondary !py-1.5 text-xs">{busy === 'test-report' ? 'Sending…' : 'Send test to me'}</button>
            <button onClick={() => run('test-slack-report')} disabled={busy !== null || !s.weeklyReport.slack} className="btn-secondary !py-1.5 text-xs">{busy === 'test-slack-report' ? 'Posting…' : 'Send test to Slack'}</button>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Toggle checked={s.weeklyReport.enabled} disabled={off} onChange={(v) => save({ weeklyReport: { enabled: v } })} label="Send the weekly report" hint="Turn the Monday email on or off." />
          <Toggle checked={s.weeklyReport.emailSuperAdmins} disabled={off || !s.weeklyReport.enabled} onChange={(v) => save({ weeklyReport: { emailSuperAdmins: v } })} label="Email Super Admins" hint="Every Super Admin in the organisation." />
          <Toggle checked={s.weeklyReport.slack} disabled={off || !s.weeklyReport.enabled} onChange={(v) => save({ weeklyReport: { slack: v } })} label="Post to Slack" hint="The same report in Slack, as “MailFlow Weekly Report”." />
        </div>
        <ChannelField label="Slack channel for the weekly report" value={s.weeklyReport.slackChannel ?? ''} disabled={off || !s.weeklyReport.enabled || !s.weeklyReport.slack} onSave={(v) => save({ weeklyReport: { slackChannel: v } })} />
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

      {/* Approvals */}
      <div className="space-y-3 border-t border-border-subtle pt-5" data-approvals-settings>
        <div>
          <h3 className="text-sm font-semibold">Approval notifications</h3>
          <p className="text-xs text-muted-foreground">Requests and decisions always appear in the app (the bell and the Approvals badge). Choose what also goes to Gmail.</p>
        </div>
        <div className="space-y-2">
          {([
            ['DIGEST', 'One summary email (recommended)', 'A single email listing everything that is waiting, sent when something new arrives and at most once per interval. No flood.'],
            ['IN_APP', 'In the app only', 'No approval emails at all. Reviewers open Approvals (the badge shows the count).'],
            ['EMAIL', 'An email for every request and decision', 'The old way: each request emails every approver and each decision replies in a thread. Floods the inbox when many campaigns need approval.'],
          ] as const).map(([value, label, hint]) => (
            <label key={value} className="flex items-start gap-2 text-sm">
              <input type="radio" name="approvalNotify" className="mt-1" checked={s.approvals.notify === value} disabled={off} onChange={() => save({ approvals: { notify: value } })} />
              <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
            </label>
          ))}
        </div>
        {s.approvals.notify === 'DIGEST' && (
          <label className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">At most one summary every</span>
            <select value={s.approvals.digestMinutes} disabled={off} onChange={(e) => save({ approvals: { digestMinutes: Number(e.target.value) } })} className="!w-auto !py-1 text-xs" aria-label="Summary interval">
              {[15, 30, 60, 120, 240, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : m < 1440 ? `${m / 60} hours` : 'day'}</option>)}
            </select>
            <span className="text-muted-foreground">Goes to every Admin and Super Admin, from the report mailbox above.</span>
          </label>
        )}
      </div>

      {/* Recruiter bulk send */}
      <div className="space-y-3 border-t border-border-subtle pt-5">
        <div>
          <h3 className="text-sm font-semibold">Recruiter bulk send</h3>
          <p className="text-xs text-muted-foreground">Default for the repeat check on new Recruiter Bulk Sends.</p>
        </div>
        <RepeatWindow value={s.recruiter.repeatWindowDays} disabled={off} onSave={(v) => save({ recruiter: { repeatWindowDays: v } })} />
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 sm:p-6" onClick={() => setPreview(null)}>
          <div className="panel flex w-full max-w-3xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Email preview">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
              <div className="min-w-0">
                <div className="eyebrow">Preview · nothing is sent</div>
                <div className="truncate text-sm font-semibold">{tab === 'slack' && preview.slack ? `Slack · #${preview.slack.channel ?? 'no channel set'} · as ${preview.slack.as.username}` : preview.subject}</div>
              </div>
              <div className="flex items-center gap-2">
                {preview.slack && (
                  <div className="segmented flex gap-1 rounded-full border border-border p-0.5 text-xs" role="tablist">
                    {(['email', 'slack'] as const).map((t) => (
                      <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1 ${tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{t === 'email' ? 'Email' : 'Slack'}</button>
                    ))}
                  </div>
                )}
                <button onClick={() => setPreview(null)} className="btn-secondary !py-1.5 text-xs">Close</button>
              </div>
            </div>
            {tab === 'slack' && preview.slack ? (
              <div className="min-h-[60vh] flex-1 overflow-hidden"><SlackPreview {...(preview.slack as unknown as Parameters<typeof SlackPreview>[0])} /></div>
            ) : (
              <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="min-h-[60vh] w-full flex-1 bg-white" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
