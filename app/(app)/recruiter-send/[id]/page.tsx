'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { STATUS_STYLE } from '@/lib/recruiterSend/ui';

type Mode = 'BCC' | 'INDIVIDUAL';
interface Video { mode: 'attach'; ref: string; fileName: string; size: number; contentType: string }
interface VideoLink { mode: 'link'; url: string; title: string }
interface Blast {
  id: string; name: string; mode: Mode; toAddress: string | null; subject: string; body: string; format: 'text' | 'html';
  includeSignature: boolean; fromName: string | null; replyTo: string | null; accountIds: string[]; accountLimits: Record<string, number>;
  video: Video | VideoLink | null; attachmentDocumentIds: string[]; groupSize: number; gapSeconds: number; status: string;
  scheduledAt: string | null; note: string | null; startedAt: string | null; completedAt: string | null; html: string;
}
interface Mailbox { id: string; emailAddress: string; ownerName: string | null; status: string; own: boolean; sentLast24h: number; dailyLimit: number }
interface Group { id: string; seq: number; status: string; recipientCount: number; fromEmail: string | null; sentAt: string | null; openCount: number; firstOpenedAt: string | null; lastOpenedAt: string | null; error: string | null }
interface RecipientRow { email: string; name: string | null; status: string; skipReason: string | null; sentAt: string | null; openedAt: string | null; openCount: number; repliedAt: string | null }
interface Detail { blast: Blast; counts: Record<string, number>; recipients: RecipientRow[]; groups: Group[]; mailboxes: Mailbox[]; hasSignature: boolean }
interface Check {
  total: number; eligible: number; skipped: { email: string; reason: string }[]; skippedByReason: Record<string, number>; messages: number; perMessage: number;
  capacity: { accountId: string; emailAddress: string; messagesLeft: number; peopleLeft: number }[]; messagesPossibleToday: number; estimatedMinutes: number; preview: string;
}

const FIELD = 'w-full rounded border bg-background px-2 py-1.5 text-sm';
const LABEL = 'mb-1 block text-xs font-medium';
const SKIP_LABEL: Record<string, string> = {
  SUPPRESSED: 'unsubscribed or bounced before', NO_MAIL_SERVER: 'domain has no mail server', LIKELY_TYPO: 'looks like a typo',
  NO_REPLY_ADDRESS: 'no-reply address', DISPOSABLE: 'throwaway inbox', INVALID: 'not a valid address',
};

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold">{n}. {title}</h2>
      {hint && <p className="mb-3 mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function RecruiterSendPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Blast | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [recipientTab, setRecipientTab] = useState<'paste' | 'file' | 'data'>('paste');
  const [pasted, setPasted] = useState('');
  const [datasets, setDatasets] = useState<{ id: string; name: string; _count?: { records: number } }[]>([]);
  const [library, setLibrary] = useState<{ id: string; name: string; file?: { size: number } }[]>([]);
  const [videoTab, setVideoTab] = useState<'attach' | 'link'>('attach');
  const [videoLink, setVideoLink] = useState({ url: '', title: 'Watch the video' });
  const [scheduleAt, setScheduleAt] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/recruiter-blasts/${params.id}`, { cache: 'no-store' }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    if (!res?.ok) return setError(j?.error ?? 'Could not load this send.');
    setDetail(j);
    setForm((f) => (f && j.blast.status === 'DRAFT' ? { ...j.blast, ...pickEditable(f) } : j.blast));
    if (j.blast.video?.mode === 'link') {
      setVideoTab('link');
      setVideoLink({ url: j.blast.video.url, title: j.blast.video.title });
    }
  }, [params.id]);

  useEffect(() => {
    load();
    fetch('/api/datasets').then((r) => r.json()).then((j) => setDatasets(j.datasets ?? [])).catch(() => undefined);
    fetch('/api/documents').then((r) => r.json()).then((j) => setLibrary((j.documents ?? []).filter((d: { archived?: boolean }) => !d.archived))).catch(() => undefined);
  }, [load]);

  // Live progress while sending (paused while the tab is hidden).
  const live = detail && ['SENDING', 'SCHEDULED'].includes(detail.blast.status);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => clearInterval(t);
  }, [live, load]);

  // Auto-save draft edits.
  function edit(patch: Partial<Blast>) {
    if (!form) return;
    const next = { ...form, ...patch };
    setForm(next);
    setCheck(null);
    setSaving('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const res = await fetch(`/api/recruiter-blasts/${params.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pickEditable(next)),
      }).catch(() => null);
      const j = await res?.json().catch(() => ({}));
      if (res?.ok) setSaving('saved');
      else {
        setSaving('idle');
        toast.error(j?.error ?? 'Could not save.');
      }
    }, 700);
  }

  async function post(path: string, body?: unknown, label?: string) {
    setBusy(label ?? path);
    const res = await fetch(`/api/recruiter-blasts/${params.id}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    setBusy(null);
    if (!res?.ok) toast.error(j?.error ?? 'Something went wrong.');
    return res?.ok ? j : null;
  }

  async function setRecipients(body: unknown) {
    const j = await post('/recipients', body, 'recipients');
    if (j) {
      toast.success(`${j.added.toLocaleString()} recruiter${j.added === 1 ? '' : 's'} from the ${j.source}.${j.unreadableCount ? ` ${j.unreadableCount} line(s) had no email address.` : ''}`);
      setPasted('');
      setCheck(null);
      load();
    }
  }

  async function runCheck() {
    setChecking(true);
    const j = await post('/check', {}, 'check');
    setChecking(false);
    if (j) setCheck(j);
  }

  async function uploadVideo(file: File) {
    setBusy('video');
    const start = await fetch(`/api/recruiter-blasts/${params.id}/video`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'start', fileName: file.name, size: file.size, contentType: file.type || 'video/mp4' }),
    }).catch(() => null);
    const s = await start?.json().catch(() => ({}));
    if (!start?.ok) { setBusy(null); return toast.error(s?.error ?? 'Could not start the upload.'); }
    const put = await fetch(s.uploadUrl, { method: 'PUT', headers: { 'content-type': file.type || 'video/mp4', 'x-upsert': 'true' }, body: file }).catch(() => null);
    if (!put?.ok) { setBusy(null); return toast.error('The video upload failed. Try again.'); }
    const done = await fetch(`/api/recruiter-blasts/${params.id}/video`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'done', ref: s.ref, fileName: file.name, size: file.size, contentType: file.type || 'video/mp4' }),
    }).catch(() => null);
    setBusy(null);
    if (done?.ok) { toast.success('Video attached.'); load(); } else toast.error('Could not attach the video.');
  }

  async function removeVideo() {
    const res = await fetch(`/api/recruiter-blasts/${params.id}/video`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) { setVideoLink({ url: '', title: 'Watch the video' }); load(); }
  }

  async function control(action: 'pause' | 'resume' | 'cancel') {
    if (action === 'cancel' && !confirm('Cancel this send? Emails already sent stay sent; the rest are not sent.')) return;
    if (await post('/control', { action }, action)) load();
  }

  async function copy() {
    const j = await post('/copy', {}, 'copy');
    if (j?.id) router.push(`/recruiter-send/${j.id}`);
  }

  async function start(scheduled: boolean) {
    if (!check) return toast.error('Run the check first.');
    const when = scheduled && scheduleAt ? new Date(scheduleAt).toISOString() : null;
    const msg = `${scheduled ? 'Schedule' : 'Send'} this to ${check.eligible.toLocaleString()} recruiter${check.eligible === 1 ? '' : 's'} in ${check.messages.toLocaleString()} email${check.messages === 1 ? '' : 's'}?`;
    if (!confirm(msg)) return;
    const j = await post('/start', { scheduledAt: when }, 'start');
    if (j) { toast.success(when ? 'Scheduled.' : 'Sending has started.'); load(); }
  }

  async function removeDraft() {
    if (!confirm('Delete this draft?')) return;
    const res = await fetch(`/api/recruiter-blasts/${params.id}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) router.push('/recruiter-send');
  }

  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!detail || !form) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  const b = detail.blast;
  const draft = b.status === 'DRAFT';
  const chosen = form.accountIds;
  const mailboxOrder = [...chosen.map((id) => detail.mailboxes.find((m) => m.id === id)).filter((m): m is Mailbox => !!m), ...detail.mailboxes.filter((m) => !chosen.includes(m.id))];

  return (
    <div className="max-w-5xl space-y-5 p-6">
      <Link href="/recruiter-send" className="text-sm text-muted-foreground hover:underline">← Recruiter Bulk Send</Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {draft ? (
            <input value={form.name} onChange={(e) => edit({ name: e.target.value })} className="w-full rounded border-transparent bg-transparent px-1 text-xl font-semibold hover:border-border focus:border-border" aria-label="Name of this send" maxLength={200} />
          ) : (
            <h1 className="text-xl font-semibold">{b.name}</h1>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className={`rounded px-1.5 py-0.5 ${STATUS_STYLE[b.status] ?? ''}`}>{b.status.toLowerCase()}</span>
            <span>{b.mode === 'BCC' ? 'BCC groups' : 'Individual copies'}</span>
            {draft && <span>{saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : ''}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {['SENDING', 'SCHEDULED'].includes(b.status) && <button type="button" onClick={() => control('pause')} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated">Pause</button>}
          {b.status === 'PAUSED' && <button type="button" onClick={() => control('resume')} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated">Resume</button>}
          {['SENDING', 'SCHEDULED', 'PAUSED'].includes(b.status) && <button type="button" onClick={() => control('cancel')} className="rounded border px-3 py-1.5 text-sm text-red-700 hover:bg-elevated">Cancel</button>}
          <button type="button" onClick={copy} disabled={busy === 'copy'} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50">Copy</button>
          {draft && <button type="button" onClick={removeDraft} className="rounded px-3 py-1.5 text-sm text-muted-foreground hover:bg-elevated">Delete draft</button>}
        </div>
      </div>

      {b.note && <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">{b.note}</p>}

      {!draft && <Progress detail={detail} />}

      {draft && (
        <>
          <Section n={1} title="Recruiters" hint="Paste addresses (one per line, or “Name <email>”), upload a CSV/Excel file, or use saved data. Duplicates are removed; unsubscribed, bounced and bad addresses are skipped at the check.">
            <div className="mb-2 flex gap-1 text-xs" role="tablist">
              {(['paste', 'file', 'data'] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={recipientTab === t} onClick={() => setRecipientTab(t)} className={`rounded px-2.5 py-1 ${recipientTab === t ? 'bg-primary text-primary-foreground' : 'border hover:bg-elevated'}`}>
                  {t === 'paste' ? 'Paste' : t === 'file' ? 'Upload file' : 'From Data'}
                </button>
              ))}
            </div>
            {recipientTab === 'paste' && (
              <div className="space-y-2">
                <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} className={`${FIELD} font-mono`} placeholder={'priya@company.com\nRahul Mehta <rahul@corp.in>\nhr@startup.io, talent@agency.com'} />
                <button type="button" disabled={!pasted.trim() || busy === 'recipients'} onClick={() => setRecipients({ source: 'paste', text: pasted })} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50">Use this list</button>
              </div>
            )}
            {recipientTab === 'file' && (
              <input type="file" accept=".csv,.xlsx,.xls,text/csv" disabled={busy === 'recipients'} onChange={async (e) => { const f = e.target.files?.[0]; if (f) setRecipients({ source: 'file', fileName: f.name, base64: await fileToBase64(f) }); e.target.value = ''; }} className="text-sm" />
            )}
            {recipientTab === 'data' && (
              <select defaultValue="" onChange={(e) => e.target.value && setRecipients({ source: 'dataset', datasetId: e.target.value })} className={`${FIELD} sm:w-96`}>
                <option value="">Choose saved data…</option>
                {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}{d._count ? ` (${d._count.records})` : ''}</option>)}
              </select>
            )}
            <p className="mt-3 text-sm"><b>{(detail.counts.total ?? 0).toLocaleString()}</b> recruiter{detail.counts.total === 1 ? '' : 's'} in this send{detail.counts.total ? ' (adding a list replaces it)' : ''}.</p>
            {detail.recipients.length > 0 && (
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer text-muted-foreground">Show the list</summary>
                <ul className="mt-1 max-h-40 overflow-auto">{detail.recipients.map((r) => <li key={r.email}>{r.name ? `${r.name} · ` : ''}{r.email}</li>)}</ul>
              </details>
            )}
          </Section>

          <Section n={2} title="How it goes out">
            <div className="grid gap-2 sm:grid-cols-2">
              {(['BCC', 'INDIVIDUAL'] as const).map((m) => (
                <label key={m} className={`cursor-pointer rounded-lg border p-3 text-sm ${form.mode === m ? 'border-primary ring-1 ring-primary' : ''}`}>
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name="mode" checked={form.mode === m} onChange={() => edit({ mode: m, gapSeconds: m === 'BCC' ? Math.max(30, form.gapSeconds) : 3 })} />
                    {m === 'BCC' ? 'BCC groups (up to 250 per email)' : 'Individual copies'}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {m === 'BCC'
                      ? 'Fastest; fewest Gmail messages. Recruiters see only the “To” address. Opens are counted per group, not per recruiter.'
                      : 'Each recruiter gets their own email (looks the same). You see exactly which recruiters opened. Uses more of the daily allowance.'}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {form.mode === 'BCC' && (
                <>
                  <label><span className={LABEL}>Visible “To” address</span><input value={form.toAddress ?? ''} onChange={(e) => edit({ toAddress: e.target.value })} className={FIELD} placeholder="placements@masaischool.com" /></label>
                  <label><span className={LABEL}>Recruiters per email (max 250)</span><input type="number" min={1} max={250} value={form.groupSize} onChange={(e) => edit({ groupSize: Math.min(250, Math.max(1, Number(e.target.value) || 1)) })} className={FIELD} /></label>
                </>
              )}
              <label>
                <span className={LABEL}>Pause between emails (seconds)</span>
                <input type="number" min={form.mode === 'BCC' ? 30 : 3} max={3600} value={form.gapSeconds} onChange={(e) => edit({ gapSeconds: Math.max(form.mode === 'BCC' ? 30 : 3, Number(e.target.value) || 0) })} className={FIELD} />
              </label>
            </div>
          </Section>

          <Section n={3} title="The email">
            <div className="space-y-3">
              <label className="block"><span className={LABEL}>Subject</span><input value={form.subject} onChange={(e) => edit({ subject: e.target.value })} className={FIELD} maxLength={300} /></label>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium">Message</span>
                  <span className="flex gap-1 text-xs">
                    {(['text', 'html'] as const).map((f) => (
                      <button key={f} type="button" onClick={() => edit({ format: f })} className={`rounded px-2 py-0.5 ${form.format === f ? 'bg-primary text-primary-foreground' : 'border'}`}>{f === 'text' ? 'Simple' : 'HTML'}</button>
                    ))}
                  </span>
                </div>
                <textarea value={form.body} onChange={(e) => edit({ body: e.target.value })} rows={10} className={`${FIELD} ${form.format === 'html' ? 'font-mono text-xs' : ''}`} placeholder={form.format === 'html' ? 'Paste your HTML email…' : 'Dear Hiring Team,\n\n…'} />
                <p className="mt-1 text-xs text-muted-foreground">Links are sent exactly as written (no click tracking). An unsubscribe line is added at the bottom.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label><span className={LABEL}>From name</span><input value={form.fromName ?? ''} onChange={(e) => edit({ fromName: e.target.value })} className={FIELD} placeholder="Masai Placements" /></label>
                <label><span className={LABEL}>Reply-To (optional)</span><input value={form.replyTo ?? ''} onChange={(e) => edit({ replyTo: e.target.value })} className={FIELD} placeholder="Replies go here instead of the sending mailbox" /></label>
              </div>
              {detail.hasSignature && (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.includeSignature} onChange={(e) => edit({ includeSignature: e.target.checked })} />Add my email signature</label>
              )}
            </div>
          </Section>

          <Section n={4} title="Attachments and video" hint="PDFs from the PDF Library, and optionally a video. Keep attachments under 22 MB in total.">
            <div className="space-y-4">
              <div>
                <span className={LABEL}>PDFs (up to 5)</span>
                {library.length === 0 ? <p className="text-xs text-muted-foreground">No PDFs in the library yet.</p> : (
                  <div className="flex max-h-40 flex-col gap-1 overflow-auto text-sm">
                    {library.map((d) => {
                      const on = form.attachmentDocumentIds.includes(d.id);
                      return (
                        <label key={d.id} className="flex items-center gap-2">
                          <input type="checkbox" checked={on} disabled={!on && form.attachmentDocumentIds.length >= 5} onChange={() => edit({ attachmentDocumentIds: on ? form.attachmentDocumentIds.filter((x) => x !== d.id) : [...form.attachmentDocumentIds, d.id] })} />
                          {d.name}{d.file?.size ? <span className="text-xs text-muted-foreground">({(d.file.size / 1048576).toFixed(1)} MB)</span> : null}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
              <div>
                <span className={LABEL}>Video</span>
                {b.video ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {b.video.mode === 'attach' ? <>🎬 {b.video.fileName} <span className="text-xs text-muted-foreground">({(b.video.size / 1048576).toFixed(1)} MB, attached)</span></> : <>▶ {b.video.title} <span className="truncate text-xs text-muted-foreground">({b.video.url})</span></>}
                    <button type="button" onClick={removeVideo} className="rounded px-2 py-0.5 text-xs text-red-700 hover:bg-elevated">Remove</button>
                  </div>
                ) : (
                  <>
                    <div className="mb-2 flex gap-1 text-xs">
                      <button type="button" onClick={() => setVideoTab('attach')} className={`rounded px-2 py-0.5 ${videoTab === 'attach' ? 'bg-primary text-primary-foreground' : 'border'}`}>Attach a file (≤ 20 MB)</button>
                      <button type="button" onClick={() => setVideoTab('link')} className={`rounded px-2 py-0.5 ${videoTab === 'link' ? 'bg-primary text-primary-foreground' : 'border'}`}>Share a link (any size)</button>
                    </div>
                    {videoTab === 'attach' ? (
                      <>
                        <input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-msvideo,video/x-matroska,video/mpeg" disabled={busy === 'video'} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadVideo(f); e.target.value = ''; }} className="text-sm" />
                        <p className="mt-1 text-xs text-muted-foreground">{busy === 'video' ? 'Uploading…' : 'Best for short clips. With individual copies an attached video can go to at most 50 recruiters — share a link for more.'}</p>
                      </>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-[1fr_14rem_auto]">
                        <input value={videoLink.url} onChange={(e) => setVideoLink({ ...videoLink, url: e.target.value })} className={FIELD} placeholder="https://drive.google.com/… or https://youtu.be/…" />
                        <input value={videoLink.title} onChange={(e) => setVideoLink({ ...videoLink, title: e.target.value })} className={FIELD} maxLength={120} aria-label="Button text" />
                        <button type="button" disabled={!videoLink.url.trim()} onClick={async () => {
                          const res = await fetch(`/api/recruiter-blasts/${params.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ videoLink }) }).catch(() => null);
                          const j = await res?.json().catch(() => ({}));
                          if (res?.ok) { toast.success('Video button added to the email.'); load(); } else toast.error(j?.error ?? 'Could not add the video link.');
                        }} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50">Add</button>
                        <p className="text-xs text-muted-foreground sm:col-span-3">Shows a “▶ Watch the video” button (with the thumbnail for YouTube). Make sure the Drive file is shared “Anyone with the link”.</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </Section>

          <Section n={5} title="Send from" hint="Tick the mailboxes to use, in order. MailFlow moves to the next one when a mailbox reaches its limit for this send, Google's daily limit, or is paused by Gmail. Leave a limit empty for no extra limit.">
            {detail.mailboxes.length === 0 ? <p className="text-sm text-muted-foreground">Connect your Gmail in Settings first.</p> : (
              <ul className="space-y-2">
                {mailboxOrder.map((m) => {
                  const on = chosen.includes(m.id);
                  const idx = chosen.indexOf(m.id);
                  return (
                    <li key={m.id} className={`flex flex-wrap items-center gap-3 rounded border p-2 text-sm ${on ? '' : 'opacity-70'}`}>
                      <input type="checkbox" checked={on} disabled={m.status !== 'CONNECTED' && !on} onChange={() => edit({ accountIds: on ? chosen.filter((x) => x !== m.id) : [...chosen, m.id] })} aria-label={`Send from ${m.emailAddress}`} />
                      <span className="min-w-0 flex-1">
                        {on && <span className="mr-1 text-xs text-muted-foreground">{idx + 1}.</span>}
                        {m.emailAddress} <span className="text-xs text-muted-foreground">{m.own ? '(you)' : m.ownerName ? `(${m.ownerName})` : ''}</span>
                        {m.status !== 'CONNECTED' && <span className="ml-1 text-xs text-red-600">{m.status.toLowerCase()}</span>}
                        <span className="block text-xs text-muted-foreground">Sent today: {m.sentLast24h.toLocaleString()} / {m.dailyLimit.toLocaleString()} emails</span>
                      </span>
                      {on && (
                        <>
                          <label className="flex items-center gap-1 text-xs">Limit for this send
                            <input type="number" min={0} value={form.accountLimits?.[m.id] ?? ''} onChange={(e) => {
                              const v = Number(e.target.value);
                              const limits = { ...(form.accountLimits ?? {}) };
                              if (!e.target.value || v <= 0) delete limits[m.id]; else limits[m.id] = Math.floor(v);
                              edit({ accountLimits: limits });
                            }} className="w-24 rounded border bg-background px-1 py-0.5" placeholder="no limit" aria-label={`Most recruiters from ${m.emailAddress}`} />
                            recruiters
                          </label>
                          <button type="button" disabled={idx === 0} onClick={() => { const a = [...chosen]; [a[idx - 1], a[idx]] = [a[idx]!, a[idx - 1]!]; edit({ accountIds: a }); }} className="rounded px-1.5 text-xs hover:bg-elevated disabled:opacity-30" aria-label="Move up">↑</button>
                          <button type="button" disabled={idx === chosen.length - 1} onClick={() => { const a = [...chosen]; [a[idx + 1], a[idx]] = [a[idx]!, a[idx + 1]!]; edit({ accountIds: a }); }} className="rounded px-1.5 text-xs hover:bg-elevated disabled:opacity-30" aria-label="Move down">↓</button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {form.mode === 'BCC' && <p className="mt-2 text-xs text-muted-foreground">Limits count whole groups: with groups of {form.groupSize}, a limit of 400 sends one group from that mailbox and moves on.</p>}
          </Section>

          <Section n={6} title="Check and send">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={runCheck} disabled={checking || saving === 'saving'} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50">{checking ? 'Checking…' : 'Check'}</button>
              <button type="button" onClick={async () => { const j = await post('/test', {}, 'test'); if (j) toast.success(`Test sent to ${j.to} from ${j.from}.`); }} disabled={busy === 'test' || saving === 'saving'} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50">{busy === 'test' ? 'Sending test…' : 'Send a test to me'}</button>
            </div>
            {check && (
              <div className="mt-4 space-y-3 text-sm">
                <p>
                  <b>{check.eligible.toLocaleString()}</b> of {check.total.toLocaleString()} recruiters will get it, in <b>{check.messages.toLocaleString()}</b> email{check.messages === 1 ? '' : 's'}
                  {form.mode === 'BCC' ? ` (up to ${check.perMessage} each)` : ''}. About {check.estimatedMinutes} minute{check.estimatedMinutes === 1 ? '' : 's'} with the pause you set.
                </p>
                {check.messagesPossibleToday < check.messages && (
                  <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
                    The chosen mailboxes can send about {check.messagesPossibleToday} of these {check.messages} emails today; the rest go out automatically as their daily limits free up. Tick more mailboxes to finish sooner.
                  </p>
                )}
                {Object.keys(check.skippedByReason).length > 0 && (
                  <details>
                    <summary className="cursor-pointer">{Object.values(check.skippedByReason).reduce((a, b2) => a + b2, 0)} skipped: {Object.entries(check.skippedByReason).map(([k, v]) => `${v} ${SKIP_LABEL[k] ?? k}`).join(', ')}</summary>
                    <ul className="mt-1 max-h-40 overflow-auto text-xs text-muted-foreground">{check.skipped.map((s) => <li key={s.email}>{s.email} — {s.reason}</li>)}</ul>
                  </details>
                )}
                <div>
                  <span className={LABEL}>Preview</span>
                  <iframe title="Email preview" srcDoc={check.preview} sandbox="" className="h-96 w-full rounded border bg-white" />
                </div>
                <div className="flex flex-wrap items-end gap-2 border-t pt-3">
                  <button type="button" onClick={() => start(false)} disabled={busy === 'start' || check.eligible === 0} className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy === 'start' ? 'Starting…' : 'Send now'}</button>
                  <label className="text-xs">or schedule for <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="ml-1 rounded border bg-background px-1 py-0.5" /></label>
                  <button type="button" onClick={() => start(true)} disabled={!scheduleAt || busy === 'start' || check.eligible === 0} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50">Schedule</button>
                </div>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function pickEditable(b: Blast) {
  return {
    name: b.name, mode: b.mode, toAddress: b.toAddress, subject: b.subject, body: b.body, format: b.format, includeSignature: b.includeSignature,
    fromName: b.fromName, replyTo: b.replyTo, accountIds: b.accountIds, accountLimits: b.accountLimits ?? {}, attachmentDocumentIds: b.attachmentDocumentIds,
    groupSize: b.groupSize, gapSeconds: b.gapSeconds,
  };
}

function Progress({ detail }: { detail: Detail }) {
  const b = detail.blast;
  const sentMessages = detail.groups.filter((g) => g.status === 'SENT').length;
  const totalMessages = detail.groups.length;
  const opens = detail.groups.reduce((n, g) => n + g.openCount, 0);
  const openedRecruiters = detail.recipients.filter((r) => r.openCount > 0).length;
  const share = totalMessages ? sentMessages / totalMessages : 0;
  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-5">
          <div><div className="text-xs text-muted-foreground">Recruiters sent</div><div className="text-xl font-semibold">{(detail.counts.SENT ?? 0).toLocaleString()} / {((detail.counts.total ?? 0) - (detail.counts.SKIPPED ?? 0)).toLocaleString()}</div></div>
          <div><div className="text-xs text-muted-foreground">Emails sent</div><div className="text-xl font-semibold">{sentMessages} / {totalMessages}</div></div>
          <div><div className="text-xs text-muted-foreground">{b.mode === 'INDIVIDUAL' ? 'Recruiters who opened' : 'Opens (all groups)'}</div><div className="text-xl font-semibold">{b.mode === 'INDIVIDUAL' ? openedRecruiters : opens}</div></div>
          <div><div className="text-xs text-muted-foreground">Replied</div><div className="text-xl font-semibold"><a className="hover:underline" href={`/inbox?filter=all&q=${encodeURIComponent(b.subject.replace(/^s*(re|fwd?)s*:s*/i, ''))}`}>{detail.counts.REPLIED ?? 0}</a></div></div>
          <div><div className="text-xs text-muted-foreground">Skipped / failed</div><div className="text-xl font-semibold">{(detail.counts.SKIPPED ?? 0) + (detail.counts.FAILED ?? 0)}</div></div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={sentMessages} aria-valuemax={totalMessages} aria-label="Emails sent">
          <div className="h-full bg-primary" style={{ width: `${share * 100}%` }} />
        </div>
        {b.mode === 'BCC' && <p className="mt-2 text-xs text-muted-foreground">BCC emails share one open counter per group, so opens show how much each group was read — not which recruiter. Gmail caches images, so counts run low.</p>}
      </section>

      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">{b.mode === 'BCC' ? 'Groups' : 'Emails'}</h2>
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
              <tr><th className="py-1 pr-2 font-medium">#</th><th className="py-1 pr-2 font-medium">Recruiters</th><th className="py-1 pr-2 font-medium">From</th><th className="py-1 pr-2 font-medium">Sent</th><th className="py-1 pr-2 font-medium">Opens</th><th className="py-1 font-medium">Status</th></tr>
            </thead>
            <tbody>
              {detail.groups.map((g) => (
                <tr key={g.id} className="border-t border-border-subtle align-top">
                  <td className="py-1 pr-2">{g.seq}</td>
                  <td className="py-1 pr-2">{g.recipientCount}</td>
                  <td className="py-1 pr-2 text-xs">{g.fromEmail ?? '—'}</td>
                  <td className="whitespace-nowrap py-1 pr-2 text-xs">{g.sentAt && g.status === 'SENT' ? new Date(g.sentAt).toLocaleString() : '—'}</td>
                  <td className="py-1 pr-2">{g.openCount}{g.firstOpenedAt && <span className="block text-xs text-muted-foreground">first {new Date(g.firstOpenedAt).toLocaleString()}</span>}</td>
                  <td className="py-1 text-xs">{g.status.toLowerCase()}{g.error && g.status !== 'SENT' && <span className="block text-red-600">{g.error}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Recruiters</h2>
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
              <tr><th className="py-1 pr-2 font-medium">Recruiter</th><th className="py-1 pr-2 font-medium">Status</th>{b.mode === 'INDIVIDUAL' && <th className="py-1 pr-2 font-medium">Opened</th>}<th className="py-1 font-medium">Replied</th></tr>
            </thead>
            <tbody>
              {detail.recipients.map((r) => (
                <tr key={r.email} className="border-t border-border-subtle align-top">
                  <td className="py-1 pr-2">{r.name ? <>{r.name} <span className="text-xs text-muted-foreground">{r.email}</span></> : r.email}</td>
                  <td className="py-1 pr-2 text-xs">{r.status.toLowerCase()}{r.skipReason && <span className="block text-muted-foreground">{r.skipReason}</span>}</td>
                  {b.mode === 'INDIVIDUAL' && <td className="py-1 pr-2 text-xs">{r.openCount > 0 ? `✓ ${r.openCount}× · ${r.openedAt ? new Date(r.openedAt).toLocaleString() : ''}` : '—'}</td>}
                  <td className="py-1 text-xs">{r.repliedAt ? <a className="text-primary hover:underline" href={`/inbox?filter=all&q=${encodeURIComponent(r.email)}`}>✓ {new Date(r.repliedAt).toLocaleString()}</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(detail.counts.total ?? 0) > detail.recipients.length && <p className="mt-1 text-xs text-muted-foreground">Showing the first {detail.recipients.length} (replied, then most opened, first).</p>}
      </section>
    </div>
  );
}
