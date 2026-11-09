'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { STATUS_STYLE } from '@/lib/recruiterSend/ui';
import { Avatar } from '@/components/ui/Avatar';
import { LivePreview, Pager, SendSummary, WhoReceives, type PlannedBatch, type PlannedPerson } from '@/components/recruiter-send/RecruiterPreview';
import { VariablePicker, variableProblems } from '@/components/recruiter-send/Variables';
import { RecipientPanel } from '@/components/recruiter-send/RecipientPanel';

type Mode = 'BCC' | 'INDIVIDUAL';
interface Video { mode: 'attach'; ref: string; fileName: string; size: number; contentType: string }
interface VideoLink { mode: 'link'; url: string; title: string }
interface Blast {
  id: string; name: string; mode: Mode; toAddress: string | null; subject: string; body: string; format: 'text' | 'html';
  includeSignature: boolean; fromName: string | null; replyTo: string | null; ccAddresses: string[]; accountIds: string[]; accountLimits: Record<string, number>;
  video: Video | VideoLink | null; attachmentDocumentIds: string[]; groupSize: number; gapSeconds: number; status: string;
  scheduledAt: string | null; note: string | null; startedAt: string | null; completedAt: string | null; html: string;
  columns: string[]; emailColumn: string | null; sendOrder: 'PARALLEL' | 'SEQUENTIAL';
}
interface Mailbox { id: string; emailAddress: string; ownerName: string | null; status: string; own: boolean; sentLast24h: number; dailyLimit: number }
interface Group { id: string; seq: number; status: string; recipientCount: number; fromEmail: string | null; sentAt: string | null; openCount: number; firstOpenedAt: string | null; lastOpenedAt: string | null; error: string | null }
interface RecipientRow { email: string; name: string | null; status: string; skipReason: string | null; sentAt: string | null; openedAt: string | null; openCount: number; repliedAt: string | null }
interface Detail { blast: Blast; counts: Record<string, number>; stats: { messagesSent: number; messagesTotal: number; opens: number; openedRecruiters: number }; recipients: RecipientRow[]; groups: Group[]; mailboxes: Mailbox[]; hasSignature: boolean; previewHtml: string; previewSubject?: string; previewRecipient?: string | null }
interface Check {
  total: number; eligible: number; skipped: { email: string; reason: string }[]; skippedByReason: Record<string, number>; messages: number; perMessage: number;
  capacity: { accountId: string; emailAddress: string; messagesLeft: number; peopleLeft: number }[]; messagesPossibleToday: number; estimatedMinutes: number; preview: string; previewSubject?: string; previewRecipient?: string | null;
  batches: PlannedBatch[]; people: PlannedPerson[]; rounds?: number; sendOrder?: 'PARALLEL' | 'SEQUENTIAL';
}

const FIELD = 'w-full rounded border bg-background px-2 py-1.5 text-sm';
const LABEL = 'mb-1 block text-xs font-medium';
const SKIP_LABEL: Record<string, string> = {
  SUPPRESSED: 'unsubscribed or bounced before', NO_MAIL_SERVER: 'domain has no mail server', LIKELY_TYPO: 'looks like a typo',
  NO_REPLY_ADDRESS: 'no-reply address', DISPOSABLE: 'throwaway inbox', INVALID: 'not a valid address', MISSING_VALUE: 'empty value for a {{variable}}',
};

/** Which steps are open. Every step folds to a one-line summary so the page stays short. */
const StepsContext = createContext<{ open: Set<number>; toggle: (n: number) => void }>({ open: new Set(), toggle: () => undefined });

function Section({ n, title, hint, summary, done, children }: { n: number; title: string; hint?: string; summary?: React.ReactNode; done?: boolean; children: React.ReactNode }) {
  const { open, toggle } = useContext(StepsContext);
  const isOpen = open.has(n);
  return (
    <section className="rounded-lg border bg-card">
      <button type="button" onClick={() => toggle(n)} aria-expanded={isOpen} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${done ? 'bg-green-600 text-white' : 'bg-muted text-muted-foreground'}`} aria-hidden>{done ? '✓' : n}</span>
        <span className="shrink-0 text-sm font-semibold">{title}</span>
        {!isOpen && summary ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span> : <span className="flex-1" />}
        <span className={`shrink-0 text-xs text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden>▾</span>
      </button>
      {isOpen && (
        <div className="border-t px-3 pb-3 pt-2">
          {hint && <p className="mb-2 text-xs text-muted-foreground">{hint}</p>}
          {children}
        </div>
      )}
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
  const [preview, setPreview] = useState('');
  // The preview's subject and whose values fill its {{variables}} (individual copies).
  const [previewAs, setPreviewAs] = useState<{ subject: string | null; recipient: string | null }>({ subject: null, recipient: null });
  // The last list sent, so the email column can be chosen again without pasting again.
  const lastSource = useRef<Record<string, unknown> | null>(null);
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastField = useRef<'subject' | 'body'>('body');
  const [ccText, setCcText] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [recipientPage, setRecipientPage] = useState(1);
  const loadedOnce = useRef(false);
  const load = useCallback(async () => {
    const res = await fetch(`/api/recruiter-blasts/${params.id}?page=${recipientPage}`, { cache: 'no-store' }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    // A failed background refresh keeps what is on screen; only a first load shows the error.
    if (!res?.ok) {
      if (!loadedOnce.current) setError(j?.error ?? 'Could not load this send.');
      return;
    }
    loadedOnce.current = true;
    setError(null);
    setDetail(j);
    setPreview(j.previewHtml ?? '');
    setPreviewAs({ subject: j.previewSubject ?? null, recipient: j.previewRecipient ?? null });
    setCcText((t) => t ?? (j.blast.ccAddresses ?? []).join(', '));
    setForm((f) => (f && j.blast.status === 'DRAFT' ? { ...j.blast, ...pickEditable(f) } : j.blast));
    if (j.blast.video?.mode === 'link') {
      setVideoTab('link');
      setVideoLink({ url: j.blast.video.url, title: j.blast.video.title });
    }
  }, [params.id, recipientPage]);

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
    // Batches depend on these; the plan refreshes by itself once the change is saved.
    const affectsPlan = (['accountIds', 'accountLimits', 'groupSize', 'mode', 'sendOrder'] as const).some((k) => k in patch);
    // Variables decide who has every value they need, so the plan follows the text too.
    const affectsVariables = ('subject' in patch || 'body' in patch) && /\{\{/.test(`${patch.subject ?? ''}${patch.body ?? ''}${form.subject}${form.body}`);
    setSaving('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const res = await fetch(`/api/recruiter-blasts/${params.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pickEditable(next)),
      }).catch(() => null);
      const j = await res?.json().catch(() => ({}));
      if (res?.ok) {
        setSaving('saved');
        if (typeof j?.previewHtml === 'string') setPreview(j.previewHtml);
        if (j && 'previewRecipient' in j) setPreviewAs({ subject: j.previewSubject ?? null, recipient: j.previewRecipient ?? null });
        if (affectsPlan || affectsVariables) runCheck();
      }
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

  async function setRecipients(body: Record<string, unknown>) {
    const j = await post('/recipients', body, 'recipients');
    if (j) {
      lastSource.current = body;
      const cols = (j.columns ?? []) as string[];
      toast.success(`${j.added.toLocaleString()} recruiter${j.added === 1 ? '' : 's'} from the ${j.source}.${cols.length ? ` ${cols.length} columns kept; email from “${j.emailColumn}”.` : ''}${j.unreadableCount ? ` ${j.unreadableCount} line(s) had no email address.` : ''}`);
      setPasted('');
      load();
      runCheck();
      setOpenSteps((prev) => new Set([...(prev ?? []), 6]));
    }
  }

  // The plan (batches, mailboxes, who gets it). Only the latest answer is kept.
  const checkSeq = useRef(0);
  async function runCheck() {
    const seq = ++checkSeq.current;
    setChecking(true);
    const res = await fetch(`/api/recruiter-blasts/${params.id}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    if (seq !== checkSeq.current) return;
    setChecking(false);
    if (res?.ok) {
      setCheck(j);
      if (typeof j.preview === 'string') {
        setPreview(j.preview);
        setPreviewAs({ subject: j.previewSubject ?? null, recipient: j.previewRecipient ?? null });
      }
    }
    else toast.error(j?.error ?? 'Could not work out the batches.');
  }

  // Show the plan as soon as a draft with recruiters opens.
  const planned = useRef(false);
  useEffect(() => {
    if (planned.current || !detail || detail.blast.status !== 'DRAFT' || !(detail.counts.total ?? 0)) return;
    planned.current = true;
    runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  // Steps start open only where something is still needed (plus the plan and send); the rest
  // fold to a one-line summary and open with a click.
  const [openSteps, setOpenSteps] = useState<Set<number> | null>(null);
  useEffect(() => {
    if (openSteps || !detail || !form || detail.blast.status !== 'DRAFT') return;
    const open = new Set<number>([7]);
    if (!(detail.counts.total ?? 0)) open.add(1);
    else open.add(6);
    if (form.mode === 'BCC' && !form.toAddress) open.add(2);
    if (!form.subject.trim() || !form.body.trim()) open.add(3);
    if (!form.accountIds.length) open.add(5);
    setOpenSteps(open);
  }, [detail, form, openSteps]);
  const toggleStep = useCallback((n: number) => setOpenSteps((prev) => {
    const next = new Set(prev ?? []);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    return next;
  }), []);

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

  // One-line summaries shown on folded steps.
  const total = detail.counts.total ?? 0;
  const ccList = splitEmails(ccText ?? '').valid;
  const attachedNames = [
    ...library.filter((d) => form.attachmentDocumentIds.includes(d.id)).map((d) => d.name),
    ...(b.video ? [b.video.mode === 'attach' ? `${b.video.fileName} (video)` : `${b.video.title} (video link)`] : []),
  ];
  const stepSummary: Record<number, string> = {
    1: total ? `${total.toLocaleString()} recruiter${total === 1 ? '' : 's'}` : 'No recruiters yet',
    2: `${form.mode === 'BCC' ? `BCC groups of ${form.groupSize} · To ${form.toAddress || '— not set'}` : 'Individual copies'} · ${form.gapSeconds}s pause · ${form.sendOrder === 'SEQUENTIAL' ? 'one mailbox after another' : 'all mailboxes together'}`,
    3: form.subject.trim() ? `“${form.subject}”${ccList.length ? ` · CC ${ccList.length}` : ''}${form.replyTo ? ` · Reply-To ${form.replyTo}` : ''}` : 'No subject yet',
    4: attachedNames.length ? attachedNames.join(', ') : 'None (optional)',
    5: chosen.length ? chosen.map((id) => detail.mailboxes.find((m) => m.id === id)?.emailAddress ?? '').filter(Boolean).join(', ') : 'No mailbox chosen',
    6: check ? `${check.messages.toLocaleString()} batch${check.messages === 1 ? '' : 'es'} · ${check.eligible.toLocaleString()} will get it${check.total - check.eligible ? ` · ${(check.total - check.eligible).toLocaleString()} skipped` : ''}` : '',
    7: check ? 'Ready to send' : '',
  };
  const stepDone: Record<number, boolean> = {
    1: total > 0,
    2: form.mode === 'INDIVIDUAL' || !!form.toAddress,
    3: !!form.subject.trim() && !!form.body.trim(),
    4: attachedNames.length > 0,
    5: chosen.length > 0,
    6: !!check && check.eligible > 0,
    7: false,
  };
  const steps = { open: openSteps ?? new Set<number>(), toggle: toggleStep };

  return (
    <StepsContext.Provider value={steps}>
    <div className={`space-y-3 p-4 sm:p-6 ${draft ? 'max-w-7xl' : 'max-w-5xl'}`}>
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
          {['SENDING', 'SCHEDULED'].includes(b.status) && <button type="button" onClick={() => control('pause')} disabled={busy !== null} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50">{busy === 'pause' ? 'Pausing…' : 'Pause'}</button>}
          {b.status === 'PAUSED' && <button type="button" onClick={() => control('resume')} disabled={busy !== null} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50">{busy === 'resume' ? 'Resuming…' : 'Resume'}</button>}
          {['SENDING', 'SCHEDULED', 'PAUSED'].includes(b.status) && <button type="button" onClick={() => control('cancel')} disabled={busy !== null} className="rounded border px-3 py-1.5 text-sm text-red-700 hover:bg-elevated disabled:opacity-50">{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</button>}
          <button type="button" onClick={copy} disabled={busy === 'copy'} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50">Copy</button>
          {draft && <button type="button" onClick={removeDraft} className="rounded px-3 py-1.5 text-sm text-muted-foreground hover:bg-elevated">Delete draft</button>}
        </div>
      </div>

      {b.note && <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">{b.note}</p>}

      {!draft && <Progress detail={detail} page={recipientPage} onPage={setRecipientPage} />}

      {draft && (
        <>
        <div className="flex items-center justify-end gap-3 text-xs">
          <button type="button" onClick={() => setOpenSteps(new Set([1, 2, 3, 4, 5, 6, 7]))} className="text-primary hover:underline">Open all steps</button>
          <button type="button" onClick={() => setOpenSteps(new Set([7]))} className="text-primary hover:underline">Close all</button>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <div className="min-w-0 space-y-3">
          <Section n={1} title="Recruiters" summary={stepSummary[1]} done={stepDone[1]} hint="Paste from Google Sheets/Excel with the header row (every column is kept for {{Column}} in the email, e.g. a UTM link per recruiter), paste plain addresses, upload a CSV/Excel file, or use saved data. Duplicates are removed; unsubscribed, bounced and bad addresses are skipped at the check.">
            <div className="mb-2 flex gap-1 text-xs" role="tablist">
              {(['paste', 'file', 'data'] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={recipientTab === t} onClick={() => setRecipientTab(t)} className={`rounded px-2.5 py-1 ${recipientTab === t ? 'bg-primary text-primary-foreground' : 'border hover:bg-elevated'}`}>
                  {t === 'paste' ? 'Paste' : t === 'file' ? 'Upload file' : 'From Data'}
                </button>
              ))}
            </div>
            {recipientTab === 'paste' && (
              <div className="space-y-2">
                <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} className={`${FIELD} font-mono`} placeholder={'Paste from a sheet, header row first:\nName\tEmail\tCompany\tUTM link\nPriya\tpriya@company.com\tAcme\thttps://masai.link/?utm_source=acme\n\n…or just addresses:\npriya@company.com\nRahul Mehta <rahul@corp.in>'} />
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
            {b.columns.length > 0 && (
              <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Email address column</span>
                  <select
                    value={b.emailColumn ?? ''}
                    disabled={!lastSource.current || busy === 'recipients'}
                    onChange={(e) => lastSource.current && setRecipients({ ...lastSource.current, emailColumn: e.target.value })}
                    className="rounded border bg-background px-2 py-1 text-xs"
                    title={lastSource.current ? 'Which column holds the address' : 'Add the list again to choose a different column'}
                  >
                    {b.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {!lastSource.current && <span className="text-muted-foreground">(add the list again to change it)</span>}
                </div>
                <div>
                  <span className="font-medium">Columns you can use in the email</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {b.columns.filter((c) => c !== b.emailColumn).map((c) => <code key={c} className="rounded bg-background px-1.5 py-0.5 ring-1 ring-border">{`{{${c}}}`}</code>)}
                  </div>
                </div>
              </div>
            )}
            <p className="mt-3 text-sm"><b>{(detail.counts.total ?? 0).toLocaleString()}</b> recruiter{detail.counts.total === 1 ? '' : 's'} in this send{detail.counts.total ? ' (adding a list replaces it)' : ''}.</p>
            {detail.recipients.length > 0 && (
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer text-muted-foreground">Show the list</summary>
                <ul className="mt-1 max-h-40 overflow-auto">{detail.recipients.map((r) => <li key={r.email}>{r.name ? `${r.name} · ` : ''}{r.email}</li>)}</ul>
              </details>
            )}
          </Section>

          <Section n={2} title="How it goes out" summary={stepSummary[2]} done={stepDone[2]}>
            <div className="grid gap-2 sm:grid-cols-2">
              {(['BCC', 'INDIVIDUAL'] as const).map((m) => (
                <label key={m} className={`cursor-pointer rounded-lg border p-3 text-sm ${form.mode === m ? 'border-primary ring-1 ring-primary' : ''}`}>
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name="mode" checked={form.mode === m} onChange={() => edit({ mode: m, gapSeconds: m === 'BCC' ? Math.max(30, form.gapSeconds) : 3 })} />
                    {m === 'BCC' ? 'BCC groups (up to 250 per email)' : 'Individual copies'}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {m === 'BCC'
                      ? 'Fastest; fewest Gmail messages. Recruiters see only the “To” address. Replies are tracked; opens are not (one email goes to many recruiters).'
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
                <span className={LABEL}>Pause between emails from the same mailbox (seconds)</span>
                <input type="number" min={form.mode === 'BCC' ? 30 : 3} max={3600} value={form.gapSeconds} onChange={(e) => edit({ gapSeconds: Math.max(form.mode === 'BCC' ? 30 : 3, Number(e.target.value) || 0) })} className={FIELD} />
              </label>
            </div>
            <fieldset className="mt-3">
              <legend className={LABEL}>With more than one mailbox</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(['PARALLEL', 'SEQUENTIAL'] as const).map((o) => (
                  <label key={o} className={`cursor-pointer rounded-lg border p-2.5 text-sm ${(form.sendOrder ?? 'PARALLEL') === o ? 'border-primary ring-1 ring-primary' : ''}`}>
                    <span className="flex items-center gap-2 font-medium">
                      <input type="radio" name="sendOrder" checked={(form.sendOrder ?? 'PARALLEL') === o} onChange={() => edit({ sendOrder: o })} />
                      {o === 'PARALLEL' ? 'All mailboxes together (faster)' : 'One mailbox after another'}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {o === 'PARALLEL'
                        ? 'Batch 1 of every mailbox goes at once, then each mailbox waits its own pause before its next email. 10 mailboxes ≈ 10× faster.'
                        : 'The first mailbox sends until its limit, then the next takes over; the pause is between every email of the send.'}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">The pause is always between two emails from the <b>same</b> mailbox, so each Gmail account sends at the pace you set.</p>
            </fieldset>
          </Section>

          <Section n={3} title="The email" summary={stepSummary[3]} done={stepDone[3]}>
            <div className="space-y-3">
              <label className="block"><span className={LABEL}>Subject</span><input ref={subjectRef} onFocus={() => (lastField.current = 'subject')} value={form.subject} onChange={(e) => edit({ subject: e.target.value })} className={FIELD} maxLength={300} /></label>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium">Message</span>
                  <span className="flex gap-1 text-xs">
                    {(['text', 'html'] as const).map((f) => (
                      <button key={f} type="button" onClick={() => edit({ format: f })} className={`rounded px-2 py-0.5 ${form.format === f ? 'bg-primary text-primary-foreground' : 'border'}`}>{f === 'text' ? 'Simple' : 'HTML'}</button>
                    ))}
                  </span>
                </div>
                <textarea ref={bodyRef} onFocus={() => (lastField.current = 'body')} value={form.body} onChange={(e) => edit({ body: e.target.value })} rows={10} className={`${FIELD} ${form.format === 'html' ? 'font-mono text-xs' : ''}`} placeholder={form.format === 'html' ? 'Paste your HTML email…' : 'Dear Hiring Team,\n\n…'} />
                <p className="mt-1 text-xs text-muted-foreground">Links are sent exactly as written (no click tracking). An unsubscribe line is added at the bottom.</p>
                <VariablePicker
                  columns={b.columns}
                  emailColumn={b.emailColumn}
                  format={form.format}
                  mode={form.mode}
                  subject={form.subject}
                  body={form.body}
                  onInsert={(token) => {
                    const field = lastField.current;
                    const el = field === 'subject' ? subjectRef.current : bodyRef.current;
                    const text = field === 'subject' ? form.subject : form.body;
                    const at = el?.selectionStart ?? text.length;
                    const end = el?.selectionEnd ?? at;
                    edit(field === 'subject' ? { subject: text.slice(0, at) + token + text.slice(end) } : { body: text.slice(0, at) + token + text.slice(end) });
                    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + token.length, at + token.length); });
                  }}
                  onIndividual={() => edit({ mode: 'INDIVIDUAL', gapSeconds: 3 })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label><span className={LABEL}>From name</span><input value={form.fromName ?? ''} onChange={(e) => edit({ fromName: e.target.value })} className={FIELD} placeholder="Masai Placements" /></label>
                <label className="sm:col-span-2">
                  <span className={LABEL}>CC (optional, up to 10)</span>
                  <input value={ccText ?? ''} onChange={(e) => { setCcText(e.target.value); edit({ ccAddresses: splitEmails(e.target.value).valid }); }} className={FIELD} placeholder="manager@masaischool.com, team@masaischool.com" />
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {splitEmails(ccText ?? '').invalid.length ? <span className="text-red-600">Not an email address: {splitEmails(ccText ?? '').invalid.join(', ')}. </span> : null}
                    {form.mode === 'BCC' ? 'Copied on every email; recruiters can see CC addresses.' : 'Each CC address gets one copy per recruiter, so CC works with up to 50 recruiters in individual mode.'}
                  </span>
                </label>
                <label><span className={LABEL}>Reply-To (optional)</span><input value={form.replyTo ?? ''} onChange={(e) => edit({ replyTo: e.target.value })} className={FIELD} placeholder="e.g. hr@masaischool.com" /><span className="mt-0.5 block text-xs text-muted-foreground">Replies go to this address <b>and</b> the sending mailbox, so MailFlow still tracks every reply.</span></label>
              </div>
              {detail.hasSignature && (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.includeSignature} onChange={(e) => edit({ includeSignature: e.target.checked })} />Add my email signature</label>
              )}
            </div>
          </Section>

          <Section n={4} title="Attachments and video" summary={stepSummary[4]} done={stepDone[4]} hint="PDFs from the PDF Library, and optionally a video. Keep attachments under 22 MB in total.">
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

          <Section n={5} title="Send from" summary={stepSummary[5]} done={stepDone[5]} hint={form.sendOrder === 'SEQUENTIAL' ? "Tick the mailboxes to use, in order. MailFlow moves to the next one when a mailbox reaches its limit for this send, Google's daily limit, or is paused by Gmail. Leave a limit empty for no extra limit." : "Tick the mailboxes to use. They all send together, each with its own pause; if one reaches its limit for this send or Google's daily limit, or Gmail pauses it, its batches move to the others. Leave a limit empty for no extra limit."}>
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
            {form.mode === 'BCC' && <p className="mt-2 text-xs text-muted-foreground">Limits count whole groups: with groups of {form.groupSize}, a limit of 400 lets that mailbox send {Math.floor(400 / Math.max(1, form.groupSize))} group{Math.floor(400 / Math.max(1, form.groupSize)) === 1 ? '' : 's'} ({(Math.floor(400 / Math.max(1, form.groupSize)) * form.groupSize).toLocaleString()} recruiters).</p>}
          </Section>

        </div>
        <aside className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-auto">
          <LivePreview
            html={preview}
            envelope={{
              mode: form.mode,
              fromName: form.fromName,
              fromEmail: detail.mailboxes.find((m) => m.id === form.accountIds[0])?.emailAddress ?? null,
              toAddress: form.toAddress,
              ccAddresses: splitEmails(ccText ?? '').valid,
              replyTo: form.replyTo,
              subject: previewAs.recipient && previewAs.subject !== null && form.mode === 'INDIVIDUAL' ? previewAs.subject : form.subject,
              previewAs: form.mode === 'INDIVIDUAL' ? previewAs.recipient : null,
              perEmail: form.groupSize,
              attachments: [
                ...library.filter((d) => form.attachmentDocumentIds.includes(d.id)).map((d) => d.name),
                ...(b.video?.mode === 'attach' ? [`${b.video.fileName} (video)`] : []),
              ],
            }}
          />
        </aside>
        </div>

          <Section n={6} title="Batches and who receives it" summary={stepSummary[6]} done={stepDone[6]} hint="Worked out from the recruiters, batch size, mailboxes and limits above, and updated as you change them. Each batch is one email; it goes from the mailbox shown.">
            {!(detail.counts.total ?? 0) ? (
              <p className="text-sm text-muted-foreground">Add recruiters in step 1 to see the batches.</p>
            ) : !form.accountIds.length ? (
              <p className="text-sm text-muted-foreground">Choose at least one mailbox in step 5 to see which account sends each batch.</p>
            ) : !check ? (
              <p className="text-sm text-muted-foreground">{checking ? 'Working out the batches…' : 'Batches will appear here.'}</p>
            ) : (
              <div className={`space-y-3 ${checking ? 'opacity-60 transition-opacity' : ''}`}>
                <SendSummary items={summaryItems(form, check, detail, library, splitEmails(ccText ?? '').valid)} warnings={summaryWarnings(form, check)} />
                <WhoReceives
                  people={check.people}
                  batches={check.batches}
                  total={check.total}
                  html={preview}
                  subject={form.subject}
                  mode={form.mode}
                  parallel={(check.sendOrder ?? form.sendOrder) !== 'SEQUENTIAL'}
                  blastId={b.id}
                  version={`${form.mode}|${form.subject}|${preview.length}|${hashText(preview)}`}
                  envelope={{ mode: form.mode, fromName: form.fromName, toAddress: form.toAddress, ccAddresses: splitEmails(ccText ?? '').valid, replyTo: form.replyTo }}
                />
              </div>
            )}
          </Section>

          <Section n={7} title="Check and send" summary={stepSummary[7]} done={stepDone[7]}>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={runCheck} disabled={checking || saving === 'saving'} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50">{checking ? 'Checking…' : 'Check again'}</button>
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
    </StepsContext.Provider>
  );
}

/** The settings of a send, as the "Review before sending" card lists them. */
function summaryItems(form: Blast, check: Check, detail: Detail, library: { id: string; name: string }[], cc: string[]): [string, string][] {
  const mailboxes = form.accountIds
    .map((id) => detail.mailboxes.find((m) => m.id === id))
    .filter((m): m is Mailbox => !!m)
    .map((m, i) => `${i + 1}. ${m.emailAddress}${form.accountLimits?.[m.id] ? ` (limit ${form.accountLimits[m.id]})` : ''}`)
    .join(', ');
  const skipped = check.total - check.eligible;
  const docs = library.filter((d) => form.attachmentDocumentIds.includes(d.id)).map((d) => d.name);
  const video = detail.blast.video ? (detail.blast.video.mode === 'attach' ? `${detail.blast.video.fileName} (attached)` : `${detail.blast.video.title} (link)`) : '';
  return [
    ['Send as', form.mode === 'BCC' ? `BCC groups of up to ${check.perMessage}` : 'Individual copies (one email per recruiter)'],
    ['Recruiters', `${check.eligible.toLocaleString()} will get it${skipped ? ` · ${skipped.toLocaleString()} skipped` : ''} (of ${check.total.toLocaleString()})`],
    ['Batches', `${check.messages.toLocaleString()} email${check.messages === 1 ? '' : 's'}${check.sendOrder !== 'SEQUENTIAL' && check.rounds ? ` in ${check.rounds.toLocaleString()} round${check.rounds === 1 ? '' : 's'} (all mailboxes together)` : ''}`],
    ['Pause', `${form.gapSeconds}s between emails from the same mailbox · about ${check.estimatedMinutes} min in all`],
    ['From name', form.fromName ?? ''],
    [form.sendOrder === 'SEQUENTIAL' ? 'Sending accounts (in order)' : 'Sending accounts (together)', mailboxes],
    ['To', form.mode === 'BCC' ? form.toAddress ?? '' : 'each recruiter'],
    ['CC', cc.join(', ')],
    ['BCC', form.mode === 'BCC' ? 'the recruiters of each batch' : ''],
    ['Reply-To', form.replyTo ? `${form.replyTo} + the sending account (so replies are tracked)` : 'the sending account'],
    ['Subject', form.subject],
    ['Attachments', [...docs, ...(video ? [video] : [])].join(', ')],
    ['Tracking', form.mode === 'INDIVIDUAL' ? 'opens and replies (links are sent as written)' : 'replies (opens only for individual copies; links are sent as written)'],
  ];
}

function summaryWarnings(form: Blast, check: Check): string[] {
  const w: string[] = [];
  if (!form.subject.trim()) w.push('Add a subject.');
  w.push(...variableProblems({ columns: form.columns ?? [], mode: form.mode, subject: form.subject, body: form.body }));
  if (check.skippedByReason.MISSING_VALUE) w.push(`${check.skippedByReason.MISSING_VALUE} recruiter(s) have an empty value for a {{variable}} and will be skipped; fill the list in, or give it a fallback like {{Name | there}}.`);
  if (form.mode === 'BCC' && !form.toAddress) w.push('BCC sends need a visible “To” address.');
  if (check.messagesPossibleToday < check.messages) w.push(`The chosen accounts can send about ${check.messagesPossibleToday} of these ${check.messages} emails today; the rest go out as their daily limits free up.`);
  if (check.batches.some((b) => !b.mailbox)) w.push('Some batches have no account with room today (see “later” below): raise a limit or tick another account to send them today.');
  return w;
}

/** Comma / space / newline separated addresses: the valid ones (lower-cased, unique) and the rest. */
function splitEmails(text: string): { valid: string[]; invalid: string[] } {
  const parts = text.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
  const ok = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  return { valid: [...new Set(parts.filter(ok).map((p) => p.toLowerCase()))].slice(0, 10), invalid: parts.filter((p) => !ok(p)) };
}

function pickEditable(b: Blast) {
  return {
    name: b.name, mode: b.mode, toAddress: b.toAddress, subject: b.subject, body: b.body, format: b.format, includeSignature: b.includeSignature,
    fromName: b.fromName, replyTo: b.replyTo, ccAddresses: b.ccAddresses ?? [], accountIds: b.accountIds, accountLimits: b.accountLimits ?? {}, attachmentDocumentIds: b.attachmentDocumentIds,
    groupSize: b.groupSize, gapSeconds: b.gapSeconds, sendOrder: b.sendOrder ?? 'PARALLEL',
  };
}

const RECIPIENTS_PER_PAGE = 200; // matches app/api/recruiter-blasts/[id]/route.ts

function Progress({ detail, page, onPage }: { detail: Detail; page: number; onPage: (p: number) => void }) {
  const b = detail.blast;
  const [open, setOpen] = useState<string | null>(null);
  const openIndex = open ? detail.recipients.findIndex((r) => r.email === open) : -1;
  const { messagesSent: sentMessages, messagesTotal: totalMessages, openedRecruiters } = detail.stats;
  // Open counts only where they name a recruiter: a BCC email is one message for many people.
  const showOpens = b.mode === 'INDIVIDUAL';
  const share = totalMessages ? sentMessages / totalMessages : 0;
  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-4">
        <div className={`grid grid-cols-2 gap-3 ${showOpens ? 'sm:grid-cols-5' : 'sm:grid-cols-4'}`}>
          <div><div className="text-xs text-muted-foreground">Recruiters sent</div><div className="text-xl font-semibold">{(detail.counts.SENT ?? 0).toLocaleString()} / {((detail.counts.total ?? 0) - (detail.counts.SKIPPED ?? 0)).toLocaleString()}</div></div>
          <div><div className="text-xs text-muted-foreground">Emails sent</div><div className="text-xl font-semibold">{sentMessages} / {totalMessages}</div></div>
          {showOpens && <div><div className="text-xs text-muted-foreground">Recruiters who opened</div><div className="text-xl font-semibold">{openedRecruiters}</div></div>}
          <div><div className="text-xs text-muted-foreground">Replied</div><div className="text-xl font-semibold"><a className="hover:underline" href={`/inbox?filter=all&q=${encodeURIComponent(b.subject.trim())}`}>{detail.counts.REPLIED ?? 0}</a></div></div>
          <div><div className="text-xs text-muted-foreground">Skipped / failed / bounced</div><div className="text-xl font-semibold">{(detail.counts.SKIPPED ?? 0) + (detail.counts.FAILED ?? 0) + (detail.counts.BOUNCED ?? 0)}{(detail.counts.BOUNCED ?? 0) > 0 && <span className="ml-1 text-xs font-normal text-muted-foreground">({detail.counts.BOUNCED} bounced)</span>}</div></div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={sentMessages} aria-valuemax={totalMessages} aria-label="Emails sent">
          <div className="h-full bg-primary" style={{ width: `${share * 100}%` }} />
        </div>
        {b.mode === 'BCC' && <p className="mt-2 text-xs text-muted-foreground">Replies show who engaged. Opens aren&apos;t tracked for BCC sends (one email goes to many recruiters, so it can&apos;t say who opened); use individual copies to see opens.</p>}
      </section>

      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">{b.mode === 'BCC' ? 'Groups' : 'Emails'}</h2>
        <div className="max-h-96 overflow-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
              <tr><th className="py-1 pr-2 font-medium">#</th><th className="py-1 pr-2 font-medium">Recruiters</th><th className="py-1 pr-2 font-medium">From</th><th className="py-1 pr-2 font-medium">Sent</th>{showOpens && <th className="py-1 pr-2 font-medium">Opens</th>}<th className="py-1 font-medium">Status</th></tr>
            </thead>
            <tbody>
              {detail.groups.map((g) => (
                <tr key={g.id} className="border-t border-border-subtle align-top">
                  <td className="py-1 pr-2">{g.seq}</td>
                  <td className="py-1 pr-2">{g.recipientCount}</td>
                  <td className="py-1 pr-2 text-xs">{g.fromEmail ?? '—'}</td>
                  <td className="whitespace-nowrap py-1 pr-2 text-xs">{g.sentAt && g.status === 'SENT' ? new Date(g.sentAt).toLocaleString() : '—'}</td>
                  {showOpens && <td className="py-1 pr-2">{g.openCount}{g.firstOpenedAt && <span className="block text-xs text-muted-foreground">first {new Date(g.firstOpenedAt).toLocaleString()}</span>}</td>}
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
          <table className="w-full min-w-[520px] text-sm">
            <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
              <tr><th className="py-1 pr-2 font-medium">Recruiter</th><th className="py-1 pr-2 font-medium">Status</th>{b.mode === 'INDIVIDUAL' && <th className="py-1 pr-2 font-medium">Opened</th>}<th className="py-1 font-medium">Replied</th></tr>
            </thead>
            <tbody>
              {detail.recipients.map((r) => (
                <tr key={r.email} onClick={() => setOpen(r.email)} title="Show the email this recruiter got" className={`cursor-pointer border-t border-border-subtle align-top hover:bg-elevated ${open === r.email ? 'bg-primary/10' : ''}`}>
                  <td className="py-1 pr-2"><span className="flex items-center gap-2"><Avatar email={r.email} name={r.name} size={24} /><span className="min-w-0">{r.name ? <>{r.name} <span className="text-xs text-muted-foreground">{r.email}</span></> : r.email}</span></span></td>
                  <td className="py-1 pr-2 text-xs">{r.status.toLowerCase()}{r.skipReason && <span className="block text-muted-foreground">{r.skipReason}</span>}</td>
                  {b.mode === 'INDIVIDUAL' && <td className="py-1 pr-2 text-xs">{r.openCount > 0 ? `✓ ${r.openCount}× · ${r.openedAt ? new Date(r.openedAt).toLocaleString() : ''}` : '—'}</td>}
                  <td className="py-1 text-xs">{r.repliedAt ? <a onClick={(ev) => ev.stopPropagation()} className="text-primary hover:underline" href={`/inbox?filter=all&q=${encodeURIComponent(r.email)}`}>✓ {new Date(r.repliedAt).toLocaleString()}</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 space-y-1">
          <Pager page={page} pages={Math.max(1, Math.ceil((detail.counts.total ?? 0) / RECIPIENTS_PER_PAGE))} onPage={onPage} label="Recruiter pages" />
          <p className="text-center text-xs text-muted-foreground">{(detail.counts.total ?? 0).toLocaleString()} recruiters · replied first{detail.blast.mode === 'INDIVIDUAL' ? ', then most opened' : ''}. Click one to see the email they got.</p>
        </div>
      </section>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setOpen(null)} role="dialog" aria-label="The email this recruiter got">
          <div className="h-full w-full max-w-2xl overflow-auto bg-background p-3 shadow-2xl" onClick={(ev) => ev.stopPropagation()}>
            <RecipientPanel
              blastId={b.id}
              email={open}
              version={b.status}
              envelope={{ mode: b.mode, fromName: b.fromName, toAddress: b.toAddress, ccAddresses: b.ccAddresses ?? [], replyTo: b.replyTo }}
              position={openIndex >= 0 ? { index: openIndex, total: detail.recipients.length } : undefined}
              onStep={(d) => { const next = detail.recipients[openIndex + d]; if (next) setOpen(next.email); }}
              onClose={() => setOpen(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** A short fingerprint of the email, so a recruiter's cached preview is refreshed when it changes. */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
