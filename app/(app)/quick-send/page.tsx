'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { EmailPreview } from '@/components/email-preview/EmailPreview';
import { looksLikeHtml, normalizePastedList } from '@/lib/quickSend/paste';

type Source = 'paste' | 'file' | 'dataset' | 'segment';

interface Table {
  headers: string[];
  rows: Record<string, string>[];
  suggestedEmailColumn: string | null;
  label: string;
}

interface Attachment {
  id: string;
  name: string;
  size: number;
}

interface Check {
  source: string;
  columns: { key: string; label: string }[];
  emailColumn: string;
  total: number;
  wouldSend: number;
  skipped: number;
  byReason: Record<string, number>;
  skippedExamples: { email: string; reason: string }[];
  unknownVariables: string[];
  preview: { to: string; subject: string; html: string; missingVariables: string[] } | null;
  sender: { emailAddress: string; status: string; sentToday: number; capacityToday: number } | null;
  backups: { id: string; emailAddress: string; ownerName: string; status: string }[];
  estimatedMinutes: number;
  approval: 'none' | 'required';
  hasSignature: boolean;
  attachments: Attachment[];
}

interface Stats {
  campaignId: string;
  name: string;
  status: string;
  createdAt: string;
  scheduledAt: string | null;
  total: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  opened: number;
  clicked: number;
  replied: number;
  unsubscribed: number;
  bounced: number;
  lastSentAt: string | null;
  batchId: string | null;
  batchStatus: string | null;
}

const REASONS: Record<string, string> = {
  NO_EMAIL: 'no email address',
  INVALID_EMAIL: 'invalid email address',
  DUPLICATE_EMAIL: 'duplicate address',
  MISSING_VARIABLE: 'a field used in the message is empty',
  ALREADY_SENT: 'already emailed',
  UNSUBSCRIBED_OR_BOUNCED: 'unsubscribed or bounced before',
};

const DRAFT_KEY = 'mf.quickSend.draft';
const FIELD = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none';
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const mb = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Quick Send: the whole campaign on one screen. Recipients, message, preview,
 * a test to yourself, send and live tracking. Under the hood it is a normal
 * campaign, so pacing, Google's limits, backup mailboxes, tracking,
 * unsubscribe and the Inbox all apply.
 */
export default function QuickSendPage() {
  // 0. Campaign name (blank = the subject + date)
  const [campaignName, setCampaignName] = useState('');

  // 1. Recipients
  const [source, setSource] = useState<Source>('paste');
  const [pasted, setPasted] = useState('');
  const [table, setTable] = useState<Table | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [emailHeader, setEmailHeader] = useState('');
  const [parsing, setParsing] = useState(false);
  const [datasets, setDatasets] = useState<{ id: string; name: string; _count?: { records: number } }[]>([]);
  const [segments, setSegments] = useState<{ id: string; name: string }[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [segmentId, setSegmentId] = useState('');

  // 2. Message
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [format, setFormat] = useState<'text' | 'html'>('text');
  const [includeSignature, setIncludeSignature] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [library, setLibrary] = useState<{ id: string; name: string; fileName: string; size: number; fieldCount: number }[]>([]);
  const [uploading, setUploading] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [lastFocus, setLastFocus] = useState<'subject' | 'body'>('body');

  // 3. Options
  const [fromName, setFromName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [backups, setBackups] = useState<string[]>([]);

  // Check, test, send, tracking
  const [check, setCheck] = useState<Check | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sending, setSending] = useState(false);
  const [current, setCurrent] = useState<{ id: string; state: string; note?: string } | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<Stats[]>([]);
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop');
  const restored = useRef(false);

  useEffect(() => {
    const get = (url: string, set: (j: any) => void) =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => j && set(j))
        .catch(() => undefined);
    get('/api/datasets', (j) => setDatasets(j.datasets ?? []));
    get('/api/segments', (j) => setSegments(j.segments ?? []));
    get('/api/templates', (j) => setTemplates((j.templates ?? []).filter((t: any) => !t.archived)));
    get('/api/documents', (j) => setLibrary((j.documents ?? []).filter((d: any) => !d.archived)));
  }, []);

  // Draft autosave: a refresh or a closed tab keeps what was typed.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        setCampaignName(d.campaignName ?? '');
        setSubject(d.subject ?? '');
        setBody(d.body ?? '');
        setFormat(d.format === 'html' ? 'html' : 'text');
        setFromName(d.fromName ?? '');
        setReplyTo(d.replyTo ?? '');
        setCc(d.cc ?? '');
        setBcc(d.bcc ?? '');
        if (d.pasted) setPasted(d.pasted);
        if (Array.isArray(d.attachments)) setAttachments(d.attachments);
        if (typeof d.includeSignature === 'boolean') setIncludeSignature(d.includeSignature);
      }
    } catch {
      /* storage unavailable: start empty */
    }
    restored.current = true;
  }, []);
  useEffect(() => {
    if (!restored.current || current) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ campaignName, subject, body, format, fromName, replyTo, cc, bcc, pasted: pasted.length < 200_000 ? pasted : '', attachments, includeSignature }));
      } catch {
        /* ignore */
      }
    }, 600);
    return () => clearTimeout(t);
  }, [campaignName, subject, body, format, fromName, replyTo, cc, bcc, pasted, attachments, includeSignature, current]);

  const loadRecent = useCallback(async () => {
    const res = await fetch('/api/quick-send');
    if (res.ok) setRecent((await res.json()).sends ?? []);
  }, []);
  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  // ── recipients: pasted text / files go through the same reader as Data → Import ──
  async function parse(init: RequestInit, label: string) {
    setParsing(true);
    const res = await fetch('/api/datasets/import/preview', { method: 'POST', ...init });
    const json = await res.json().catch(() => ({}));
    setParsing(false);
    if (!res.ok) {
      setTable(null);
      setTableError(json.error ?? 'Could not read that list. Paste one email per line, or rows with a header row.');
      return;
    }
    setTableError(null);
    setTable({ headers: json.headers, rows: json.rows, suggestedEmailColumn: json.suggestedEmailColumn, label });
    setEmailHeader(json.suggestedEmailColumn ?? '');
  }

  useEffect(() => {
    if (source !== 'paste') return;
    if (!pasted.trim()) {
      setTable(null);
      setTableError(null);
      return;
    }
    const t = setTimeout(() => {
      parse({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'paste', text: normalizePastedList(pasted) }) }, 'Pasted list');
    }, 500);
    return () => clearTimeout(t);
  }, [pasted, source]);

  function onFile(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    parse({ body: fd }, file.name);
  }

  const recipients = useMemo(() => {
    if ((source === 'paste' || source === 'file') && table) {
      return { kind: 'table' as const, headers: table.headers, rows: table.rows, emailHeader: emailHeader || undefined };
    }
    if (source === 'dataset' && datasetId) return { kind: 'dataset' as const, datasetId };
    if (source === 'segment' && segmentId) return { kind: 'segment' as const, segmentId };
    return null;
  }, [source, table, emailHeader, datasetId, segmentId]);

  const payload = useCallback(
    (mode: 'check' | 'test' | 'send') => ({
      mode,
      recipients,
      name: campaignName.trim() || undefined,
      subject,
      body,
      format,
      includeSignature,
      attachmentDocumentIds: attachments.map((a) => a.id),
      fromName: fromName || undefined,
      replyTo: replyTo || '',
      cc: cc || undefined,
      bcc: bcc || undefined,
      fallbackAccountIds: backups,
      scheduledAt: scheduleAt ? new Date(scheduleAt).toISOString() : undefined,
    }),
    [recipients, campaignName, subject, body, format, includeSignature, attachments, fromName, replyTo, cc, bcc, backups, scheduleAt],
  );

  // ── live check: dry run + preview as you type ──
  useEffect(() => {
    if (!recipients || !subject.trim() || !body.trim()) {
      setCheck(null);
      setCheckError(null);
      return;
    }
    const t = setTimeout(async () => {
      setChecking(true);
      const res = await fetch('/api/quick-send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload('check')) });
      const json = await res.json().catch(() => ({}));
      setChecking(false);
      if (!res.ok) {
        setCheck(null);
        setCheckError(json.issues?.[0]?.message ?? json.error ?? 'Could not check this send');
        return;
      }
      setCheckError(null);
      setCheck(json);
    }, 700);
    return () => clearTimeout(t);
  }, [payload, recipients, subject, body]);

  // ── tracking for the send just made ──
  useEffect(() => {
    if (!current) return;
    let stop = false;
    const tick = async () => {
      const res = await fetch(`/api/quick-send/${current.id}`);
      if (res.ok && !stop) setStats((await res.json()).stats);
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [current]);

  function insertField(key: string) {
    const token = `{{${key}}}`;
    if (lastFocus === 'subject' && subjectRef.current) {
      const el = subjectRef.current;
      const at = el.selectionStart ?? subject.length;
      setSubject(subject.slice(0, at) + token + subject.slice(el.selectionEnd ?? at));
      return;
    }
    const el = bodyRef.current;
    const at = el?.selectionStart ?? body.length;
    setBody(body.slice(0, at) + token + body.slice(el?.selectionEnd ?? at));
  }

  async function loadTemplate(id: string) {
    if (!id) return;
    if ((subject.trim() || body.trim()) && !confirm('Replace the subject and message with this template?')) return;
    const res = await fetch(`/api/templates/${id}`);
    const json = await res.json().catch(() => ({}));
    const v = json.template?.versions?.[0];
    if (!res.ok || !v) {
      toast.error('Could not load that template');
      return;
    }
    setSubject(v.subject ?? '');
    setBody(v.html ?? '');
    setFormat('html');
    toast.success(`Loaded "${json.template.name}". It's in HTML; edit it there or switch to Simple to write fresh.`);
  }

  async function uploadPdf(file: File) {
    if (!/\.pdf$/i.test(file.name)) {
      toast.error('Only PDF files can be attached. Save Word or Excel files as PDF first.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      toast.error('That PDF is over 4 MB. Compress it, or split it, and try again.');
      return;
    }
    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', file.name.replace(/\.pdf$/i, ''));
    const res = await fetch('/api/documents', { method: 'POST', body: fd });
    const json = await res.json().catch(() => ({}));
    setUploading(false);
    if (!res.ok) {
      toast.error(json.error ?? 'Could not attach that PDF');
      return;
    }
    setAttachments((prev) => [...prev, { id: json.document.id, name: file.name, size: file.size }]);
  }

  function addFromLibrary(id: string) {
    const d = library.find((x) => x.id === id);
    if (!d || attachments.some((a) => a.id === id)) return;
    if (d.fieldCount > 0) toast.warning(`"${d.name}" has fill-in fields; they are filled per recipient where your list has matching columns.`);
    setAttachments((prev) => [...prev, { id: d.id, name: d.fileName, size: d.size }]);
  }

  async function sendTest() {
    setTesting(true);
    const res = await fetch('/api/quick-send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload('test')) });
    const json = await res.json().catch(() => ({}));
    setTesting(false);
    if (!res.ok) toast.error(json.issues?.[0]?.message ?? json.error ?? 'Could not send the test');
    else toast.success(`Test sent to ${json.sentTo} (filled in as ${json.filledAs}). Check your inbox.`, { duration: 8000 });
  }

  async function send() {
    if (!check) return;
    const who = `${check.wouldSend} ${check.wouldSend === 1 ? 'person' : 'people'}`;
    const when = scheduleAt ? ` at ${new Date(scheduleAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ' now';
    const att = attachments.length ? ` with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : '';
    const msg =
      check.approval === 'required'
        ? `Send this${att} to ${who}? It goes to an admin first and sends automatically as soon as it is approved.`
        : `Send this${att} to ${who}${when}? Emails go out 3 seconds apart from ${check.sender?.emailAddress}.`;
    if (!confirm(msg)) return;
    setSending(true);
    const res = await fetch('/api/quick-send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload('send')) });
    const json = await res.json().catch(() => ({}));
    setSending(false);
    if (!res.ok) {
      toast.error(json.issues?.[0]?.message ?? json.error ?? 'Could not send');
      return;
    }
    setCurrent({ id: json.campaignId, state: json.state, note: json.note });
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
    toast.success(json.state === 'awaiting_approval' ? 'Sent for approval. It goes out as soon as an admin approves it.' : json.state === 'scheduled' ? 'Scheduled.' : 'Sending started.');
    loadRecent();
  }

  async function control(action: 'PAUSE' | 'RESUME') {
    if (!stats?.batchId) return;
    const res = await fetch(`/api/batches/${stats.batchId}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) toast.error(json.error ?? 'Could not change it');
    else toast.success(action === 'PAUSE' ? 'Paused' : 'Resumed');
  }

  function startOver() {
    setCurrent(null);
    setStats(null);
    setCampaignName('');
    setPasted('');
    setTable(null);
    setSubject('');
    setBody('');
    setScheduleAt('');
    setAttachments([]);
  }

  const fields = check?.columns ?? (table ? table.headers.map((h) => ({ key: h, label: h })) : []);
  const overCapacity = check?.sender && check.wouldSend > check.sender.capacityToday;
  const ready = !!check && check.wouldSend > 0 && !check.unknownVariables.length && check.sender?.status === 'CONNECTED' && !checking;
  const attachedBytes = attachments.reduce((n, a) => n + a.size, 0);

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="mb-5">
        <div className="eyebrow mb-2">Mail</div>
        <h1 className="font-heading text-2xl font-bold tracking-tight">Quick Send</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste a list, write the email, send. Every email is personalised, tracked (opens, clicks, replies) and has an unsubscribe link.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_440px]">
        {/* ── Left: who + message + options ── */}
        <div className="space-y-5">
          <section className="rounded-lg border bg-card p-4">
            <label htmlFor="qs-name" className="mb-1 block text-sm font-semibold">
              Campaign name
            </label>
            <input
              id="qs-name"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              maxLength={150}
              placeholder={subject.trim() ? `${subject.trim().slice(0, 60)} · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'e.g. October drive: interview confirmations'}
              className={FIELD}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">How this send appears in Campaigns, reports and Approvals. Leave it blank to use the subject and date.</p>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">1. Who gets it</h2>
            <div className="mb-3 flex flex-wrap gap-1 rounded-full border border-border bg-muted/30 p-1 text-xs">
              {(
                [
                  ['paste', 'Paste a list'],
                  ['file', 'Upload CSV / Excel'],
                  ['dataset', 'Saved data'],
                  ['segment', 'Segment'],
                ] as [Source, string][]
              ).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setSource(k)}
                  className={`rounded-full px-3 py-1 ${source === k ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {l}
                </button>
              ))}
            </div>

            {source === 'paste' && (
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={6}
                placeholder={'One email per line, or "Name, email" per line:\nrahul@example.com\nNeha Singh, neha@example.com\n\nOr copy rows straight from Google Sheets / Excel, including the header row (Name, Email, Company…)'}
                className={`${FIELD} font-mono`}
              />
            )}
            {source === 'file' && (
              <label className="flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground hover:border-primary hover:text-primary">
                <span>{table ? table.label : 'Choose a .csv or .xlsx file'}</span>
                <span className="text-[11px]">The first row must be the column names (Name, Email, …)</span>
                <input type="file" accept=".csv,.xlsx" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              </label>
            )}
            {source === 'dataset' && (
              <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} className={FIELD}>
                <option value="">Choose a list from Data…</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d._count ? ` (${d._count.records} rows)` : ''}
                  </option>
                ))}
              </select>
            )}
            {source === 'segment' && (
              <select value={segmentId} onChange={(e) => setSegmentId(e.target.value)} className={FIELD}>
                <option value="">Choose a segment…</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}

            {parsing && <p className="mt-2 text-xs text-muted-foreground">Reading the list…</p>}
            {tableError && (source === 'paste' || source === 'file') && <p className="mt-2 text-xs text-destructive">{tableError}</p>}
            {table && (source === 'paste' || source === 'file') && (
              <div className="mt-3">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-success">✓ {table.rows.length} rows read</span>
                  {table.headers.length > 1 && (
                    <label className="ml-auto flex items-center gap-1">
                      Email column
                      <select value={emailHeader} onChange={(e) => setEmailHeader(e.target.value)} className="!w-auto rounded border border-border bg-background px-1 py-0.5 text-xs">
                        <option value="">Auto-detect</option>
                        {table.headers.map((h) => (
                          <option key={h}>{h}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 text-left text-muted-foreground">
                      <tr>
                        {table.headers.map((h) => (
                          <th key={h} className="px-2 py-1 font-medium">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {table.rows.slice(0, 4).map((r, i) => (
                        <tr key={i} className="border-t border-border-subtle">
                          {table.headers.map((h) => (
                            <td key={h} className="max-w-[220px] truncate px-2 py-1">
                              {r[h]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {table.rows.length > 4 && <div className="border-t border-border-subtle px-2 py-1 text-[11px] text-muted-foreground">…and {table.rows.length - 4} more</div>}
                </div>
              </div>
            )}
          </section>

          <section className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">2. The email</h2>
              <div className="flex items-center gap-2">
                {templates.length > 0 && (
                  <select value="" onChange={(e) => loadTemplate(e.target.value)} className="!w-auto rounded-md border border-border bg-background px-2 py-1 text-xs" aria-label="Start from a saved template">
                    <option value="">Start from a template…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
                <div className="flex rounded-full border border-border p-0.5 text-[11px]">
                  <button onClick={() => setFormat('text')} className={`rounded-full px-2 py-0.5 ${format === 'text' ? 'bg-foreground text-background' : 'text-muted-foreground'}`}>Simple</button>
                  <button onClick={() => setFormat('html')} className={`rounded-full px-2 py-0.5 ${format === 'html' ? 'bg-foreground text-background' : 'text-muted-foreground'}`}>HTML</button>
                </div>
              </div>
            </div>

            <label htmlFor="qs-subject" className="mb-1 block text-xs font-medium">
              Subject
            </label>
            <input
              id="qs-subject"
              ref={subjectRef}
              value={subject}
              onFocus={() => setLastFocus('subject')}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. {{Name}}, your interview is confirmed"
              className={`${FIELD} mb-4 font-medium`}
            />

            <label htmlFor="qs-body" className="mb-1 block text-xs font-medium">
              Message
            </label>
            <textarea
              id="qs-body"
              ref={bodyRef}
              value={body}
              onFocus={() => setLastFocus('body')}
              onChange={(e) => {
                const next = e.target.value;
                // Pasting a designed HTML email into Simple mode: switch to HTML so it renders, not shows as code.
                if (format === 'text' && looksLikeHtml(next) && next.length - body.length > 200) {
                  setFormat('html');
                  toast.success('That looks like an HTML email, so the message is now in HTML mode and will show as designed.');
                }
                setBody(next);
              }}
              rows={12}
              placeholder={format === 'text' ? 'Hi {{Name}},\n\nWrite your message here. Links become clickable automatically.\n\nRegards,\nPlacement Team' : '<p>Hi {{Name}},</p>\n<p>…</p>'}
              className={`${FIELD} ${format === 'html' ? 'font-mono' : ''}`}
            />
            {fields.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
                <span className="text-muted-foreground">Insert a field into the {lastFocus === 'subject' ? 'subject' : 'message'}:</span>
                {fields.map((f) => (
                  <button key={f.key} onClick={() => insertField(f.key)} className="rounded-full border border-border px-2 py-0.5 hover:border-primary hover:text-primary">
                    {f.label}
                  </button>
                ))}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={includeSignature} onChange={(e) => setIncludeSignature(e.target.checked)} className="accent-primary" />
                Add my email signature
              </label>
              {check && !check.hasSignature && includeSignature && (
                <span className="text-muted-foreground">
                  You haven&apos;t saved one yet: <Link href="/settings" className="underline">Settings → Email signature</Link>
                </span>
              )}
            </div>

            {/* Attachments (PDF) */}
            <div className="mt-4 rounded-md border border-dashed border-border p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">Attachments</span>
                <span className="text-muted-foreground">PDF only, up to 4 MB each and 10 MB in total. The same file goes to everyone.</span>
              </div>
              {attachments.length > 0 && (
                <ul className="mb-2 space-y-1">
                  {attachments.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1 text-sm">
                      <span aria-hidden>📎</span>
                      <span className="flex-1 truncate">{a.name}</span>
                      <span className="text-xs text-muted-foreground">{mb(a.size)}</span>
                      <button onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))} className="text-xs text-muted-foreground hover:text-destructive" aria-label={`Remove ${a.name}`}>
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {attachedBytes > 10 * 1024 * 1024 && <p className="mb-2 text-xs text-destructive">Attachments are over 10 MB in total. Remove one.</p>}
              <div className="flex flex-wrap items-center gap-2">
                <label className={`btn-secondary cursor-pointer !py-1 text-xs ${uploading || attachments.length >= 5 ? 'pointer-events-none opacity-50' : ''}`}>
                  {uploading ? 'Uploading…' : '+ Attach a PDF'}
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadPdf(f);
                      e.target.value = '';
                    }}
                  />
                </label>
                {library.length > 0 && (
                  <select value="" onChange={(e) => addFromLibrary(e.target.value)} disabled={attachments.length >= 5} className="!w-auto rounded-md border border-border bg-background px-2 py-1 text-xs">
                    <option value="">…or pick from the PDF Library</option>
                    {library
                      .filter((d) => !attachments.some((a) => a.id === d.id))
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({mb(d.size)})
                        </option>
                      ))}
                  </select>
                )}
              </div>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Personalise with a column name in double braces, like <code className="font-mono">{'{{Name}}'}</code>. An unsubscribe link is added at the bottom automatically.
            </p>
          </section>

          <details className="rounded-lg border bg-card p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              3. More options <span className="font-normal text-muted-foreground">(sender name, Reply-To, Cc/Bcc, send later, backup mailboxes)</span>
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium">
                From name
                <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Placement Team" className={`${FIELD} mt-1 font-normal`} />
              </label>
              <label className="text-xs font-medium">
                Reply-To (optional)
                <input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="placements@masaischool.com" className={`${FIELD} mt-1 font-normal`} />
              </label>
              <label className="text-xs font-medium">
                Cc on every email
                <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="placements@masaischool.com" className={`${FIELD} mt-1 font-normal`} />
              </label>
              <label className="text-xs font-medium">
                Bcc on every email
                <input value={bcc} onChange={(e) => setBcc(e.target.value)} className={`${FIELD} mt-1 font-normal`} />
              </label>
              <label className="text-xs font-medium">
                Send later (optional)
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className={`${FIELD} mt-1 font-normal`} />
              </label>
              <div className="text-xs font-medium">
                Backup mailboxes
                <span className="block font-normal text-muted-foreground">Used if yours reaches Google&apos;s daily limit.</span>
                {check?.backups.length ? (
                  <div className="mt-1 space-y-1 font-normal">
                    {check.backups.map((b) => (
                      <label key={b.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          disabled={b.status !== 'CONNECTED'}
                          checked={backups.includes(b.id)}
                          onChange={(e) => setBackups((prev) => (e.target.checked ? [...prev, b.id] : prev.filter((x) => x !== b.id)))}
                          className="accent-primary"
                        />
                        {b.emailAddress} <span className="text-xs text-muted-foreground">({b.ownerName})</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 font-normal text-muted-foreground">None available. Teammates offer theirs in Settings → Gmail.</p>
                )}
              </div>
            </div>
          </details>
        </div>

        {/* ── Right: check, test, send / tracking, preview ── */}
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          {current ? (
            <TrackingCard current={current} stats={stats} onPause={() => control('PAUSE')} onResume={() => control('RESUME')} onNew={startOver} />
          ) : (
            <section className="rounded-lg border bg-card p-4">
              <h2 className="mb-2 text-sm font-semibold">Ready to send?</h2>
              {!recipients || !subject.trim() || !body.trim() ? (
                <ul className="space-y-1 text-sm text-muted-foreground">
                  <li>{recipients ? '✓' : '○'} Who gets it</li>
                  <li>{subject.trim() ? '✓' : '○'} Subject</li>
                  <li>{body.trim() ? '✓' : '○'} Message</li>
                  <li className="pt-1 text-xs">The check and a preview of the real email appear here as you type.</li>
                </ul>
              ) : checking && !check ? (
                <p className="text-sm text-muted-foreground">Checking…</p>
              ) : checkError ? (
                <p className="text-sm text-destructive">{checkError}</p>
              ) : check ? (
                <div className="space-y-2 text-sm">
                  <div className="text-2xl font-bold">
                    {check.wouldSend} <span className="text-sm font-normal text-muted-foreground">of {check.total} will get this email</span>
                  </div>
                  {check.skipped > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-amber-700">
                        {check.skipped} skipped: {Object.entries(check.byReason).map(([k, v]) => `${v} ${REASONS[k] ?? k.toLowerCase().replace(/_/g, ' ')}`).join(', ')}
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-muted-foreground">
                        {check.skippedExamples.map((s, i) => (
                          <li key={i}>
                            {s.email}: {s.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {check.unknownVariables.length > 0 && (
                    <p className="text-xs text-destructive">
                      These fields aren&apos;t in your list: {check.unknownVariables.map((v) => `{{${v}}}`).join(', ')}. Use the field buttons, or fix the spelling.
                    </p>
                  )}
                  {check.attachments.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      📎 {check.attachments.length} attachment{check.attachments.length === 1 ? '' : 's'} ({mb(check.attachments.reduce((n, a) => n + a.size, 0))}) on every email
                    </p>
                  )}
                  {!check.sender || check.sender.status !== 'CONNECTED' ? (
                    <p className="text-xs text-destructive">
                      Connect your Gmail first: <Link href="/settings" className="underline">Settings → Gmail</Link>.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      From {check.sender.emailAddress} · about {check.estimatedMinutes} min (one email every 3 s) · you can close this page while it sends.
                      {overCapacity && (
                        <span className="mt-1 block text-amber-700">
                          Your mailbox can send {check.sender.capacityToday} more today (Google&apos;s limit). The rest wait for the limit to free up
                          {check.backups.length ? ', or tick a backup mailbox under More options.' : '.'}
                        </span>
                      )}
                    </p>
                  )}
                  <button onClick={send} disabled={!ready || sending || attachedBytes > 10 * 1024 * 1024} className="btn-primary w-full !py-2.5 text-sm disabled:opacity-50">
                    {sending
                      ? 'Starting…'
                      : check.approval === 'required'
                        ? `Send to ${check.wouldSend} (after admin approval)`
                        : scheduleAt
                          ? `Schedule for ${check.wouldSend} ${check.wouldSend === 1 ? 'person' : 'people'}`
                          : `Send to ${check.wouldSend} ${check.wouldSend === 1 ? 'person' : 'people'}`}
                  </button>
                  <button onClick={sendTest} disabled={!ready || testing} className="btn-secondary w-full !py-1.5 text-xs disabled:opacity-50">
                    {testing ? 'Sending test…' : 'Send a test to me first'}
                  </button>
                  {check.approval === 'required' && (
                    <p className="text-[11px] text-muted-foreground">An admin approves it in one click; it then sends by itself. You&apos;ll get an email when it&apos;s approved.</p>
                  )}
                </div>
              ) : null}
            </section>
          )}

          {check?.preview && !current && (
            <section className="overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="truncate">
                    <span className="text-muted-foreground">To:</span> {check.preview.to}
                  </div>
                  <div className="truncate font-medium">{check.preview.subject}</div>
                </div>
                <div className="flex shrink-0 rounded-full border border-border p-0.5 text-[10px]">
                  <button onClick={() => setPreviewMode('desktop')} className={`rounded-full px-2 ${previewMode === 'desktop' ? 'bg-foreground text-background' : ''}`}>Desktop</button>
                  <button onClick={() => setPreviewMode('mobile')} className={`rounded-full px-2 ${previewMode === 'mobile' ? 'bg-foreground text-background' : ''}`}>Phone</button>
                </div>
              </div>
              <div className="h-[420px]">
                <EmailPreview html={check.preview.html} mode={previewMode} />
              </div>
            </section>
          )}
        </div>
      </div>

      {recent.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold">Your recent Quick Sends</h2>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Sent</th>
                  <th className="px-3 py-2 text-right">Opened</th>
                  <th className="px-3 py-2 text-right">Clicked</th>
                  <th className="px-3 py-2 text-right">Replied</th>
                  <th className="px-3 py-2 text-right">Failed</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((s) => (
                  <tr key={s.campaignId} className="border-t border-border-subtle">
                    <td className="px-3 py-2">
                      <Link href={`/campaigns/${s.campaignId}`} className="hover:text-primary">
                        {s.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{statusWords(s)}</td>
                    <td className="px-3 py-2 text-right">
                      {s.sent}/{s.total}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {s.opened} <span className="text-xs text-muted-foreground">({pct(s.opened, s.sent)}%)</span>
                    </td>
                    <td className="px-3 py-2 text-right">{s.clicked}</td>
                    <td className="px-3 py-2 text-right">{s.replied}</td>
                    <td className="px-3 py-2 text-right">{s.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function statusWords(s: Stats): string {
  if (s.status === 'PENDING_APPROVAL') return 'Waiting for approval';
  if (s.status === 'SCHEDULED') return `Scheduled${s.scheduledAt ? ` for ${new Date(s.scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}`;
  if (s.status === 'PAUSED') return 'Paused';
  if (s.status === 'REJECTED') return 'Rejected';
  if (s.status === 'CANCELLED') return 'Cancelled';
  if (s.queued > 0) {
    const quiet = s.lastSentAt && Date.now() - new Date(s.lastSentAt).getTime() > 3 * 60_000;
    return quiet ? 'Waiting (daily limit or Gmail asked to slow down); resumes by itself' : 'Sending';
  }
  if (s.status === 'COMPLETED' || s.status === 'PARTIALLY_FAILED') return s.failed ? `Done, ${s.failed} failed` : 'Done';
  return s.status.toLowerCase().replace(/_/g, ' ');
}

function TrackingCard({
  current,
  stats,
  onPause,
  onResume,
  onNew,
}: {
  current: { id: string; state: string; note?: string };
  stats: Stats | null;
  onPause: () => void;
  onResume: () => void;
  onNew: () => void;
}) {
  const done = stats ? stats.sent + stats.failed : 0;
  const total = stats ? Math.max(stats.total - stats.skipped, 0) : 0;
  const tile = (label: string, value: number, sub?: string) => (
    <div className="rounded-md border p-2">
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <div className="text-xl font-bold">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Tracking</h2>
        <span className="text-xs text-muted-foreground">{stats ? statusWords(stats) : current.state === 'awaiting_approval' ? 'Waiting for approval' : 'Starting…'}</span>
      </div>
      {current.note && current.state === 'awaiting_approval' && <p className="mb-2 text-xs text-muted-foreground">{current.note}</p>}
      {stats && (
        <>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>
              {stats.sent} of {total} sent
            </span>
            <span>{pct(done, total)}%</span>
          </div>
          <div className="mb-3 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct(done, total)}%` }} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {tile('Opened', stats.opened, `${pct(stats.opened, stats.sent)}%`)}
            {tile('Clicked', stats.clicked, `${pct(stats.clicked, stats.sent)}%`)}
            {tile('Replied', stats.replied, `${pct(stats.replied, stats.sent)}%`)}
            {tile('Failed', stats.failed)}
            {tile('Unsubscribed', stats.unsubscribed)}
            {tile('Bounced', stats.bounced)}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">Updates every few seconds. Opens are approximate: some email apps block tracking images.</p>
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {stats?.queued ? (
          stats.status === 'PAUSED' ? (
            <button onClick={onResume} className="btn-secondary !py-1 text-xs">
              Resume
            </button>
          ) : (
            <button onClick={onPause} className="btn-secondary !py-1 text-xs">
              Pause
            </button>
          )
        ) : null}
        <Link href={`/campaigns/${current.id}`} className="btn-secondary !py-1 text-xs">
          Full report
        </Link>
        <Link href="/inbox" className="btn-secondary !py-1 text-xs">
          Replies in Inbox
        </Link>
        <button onClick={onNew} className="ml-auto text-xs text-primary hover:underline">
          New Quick Send
        </button>
      </div>
    </section>
  );
}
