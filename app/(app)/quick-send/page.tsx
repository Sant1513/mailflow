'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { EmailPreview } from '@/components/email-preview/EmailPreview';
import { normalizePastedList } from '@/lib/quickSend/paste';

type Source = 'paste' | 'file' | 'dataset' | 'segment';

interface Table {
  headers: string[];
  rows: Record<string, string>[];
  suggestedEmailColumn: string | null;
  label: string;
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

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

/**
 * Quick Send: the whole campaign on one screen. Recipients, message, preview,
 * send and live tracking. Under the hood it is a normal campaign, so pacing,
 * Google's limits, backup mailboxes, tracking, unsubscribe and the Inbox all apply.
 */
export default function QuickSendPage() {
  // 1. Recipients
  const [source, setSource] = useState<Source>('paste');
  const [pasted, setPasted] = useState('');
  const [table, setTable] = useState<Table | null>(null);
  const [emailHeader, setEmailHeader] = useState('');
  const [parsing, setParsing] = useState(false);
  const [datasets, setDatasets] = useState<{ id: string; name: string; _count?: { records: number } }[]>([]);
  const [segments, setSegments] = useState<{ id: string; name: string }[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [segmentId, setSegmentId] = useState('');

  // 2. Message
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [format, setFormat] = useState<'text' | 'html'>('text');
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

  // Check + send + tracking
  const [check, setCheck] = useState<Check | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [current, setCurrent] = useState<{ id: string; state: string; note?: string } | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<Stats[]>([]);
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop');

  useEffect(() => {
    fetch('/api/datasets').then((r) => (r.ok ? r.json() : null)).then((j) => j && setDatasets(j.datasets ?? [])).catch(() => undefined);
    fetch('/api/segments').then((r) => (r.ok ? r.json() : null)).then((j) => j && setSegments(j.segments ?? [])).catch(() => undefined);
  }, []);

  const loadRecent = useCallback(async () => {
    const res = await fetch('/api/quick-send');
    if (res.ok) setRecent((await res.json()).sends ?? []);
  }, []);
  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  // ── recipients: parse pasted text / files with the same parser as Data → Import ──
  async function parse(init: RequestInit, label: string) {
    setParsing(true);
    const res = await fetch('/api/datasets/import/preview', { method: 'POST', ...init });
    const json = await res.json().catch(() => ({}));
    setParsing(false);
    if (!res.ok) {
      setTable(null);
      toast.error(json.error ?? 'Could not read that list');
      return;
    }
    setTable({ headers: json.headers, rows: json.rows, suggestedEmailColumn: json.suggestedEmailColumn, label });
    setEmailHeader(json.suggestedEmailColumn ?? '');
  }

  useEffect(() => {
    if (source !== 'paste') return;
    if (!pasted.trim()) {
      setTable(null);
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
    (mode: 'check' | 'send') => ({
      mode,
      recipients,
      subject,
      body,
      format,
      fromName: fromName || undefined,
      replyTo: replyTo || '',
      cc: cc || undefined,
      bcc: bcc || undefined,
      fallbackAccountIds: backups,
      scheduledAt: scheduleAt ? new Date(scheduleAt).toISOString() : undefined,
    }),
    [recipients, subject, body, format, fromName, replyTo, cc, bcc, backups, scheduleAt],
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

  async function send() {
    if (!check) return;
    const who = `${check.wouldSend} ${check.wouldSend === 1 ? 'person' : 'people'}`;
    const when = scheduleAt ? ` at ${new Date(scheduleAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ' now';
    const msg =
      check.approval === 'required'
        ? `Send this to ${who}? It goes to an admin first and sends automatically as soon as it is approved.`
        : `Send this to ${who}${when}? Emails go out 3 seconds apart from ${check.sender?.emailAddress}.`;
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
    setPasted('');
    setTable(null);
    setSubject('');
    setBody('');
    setScheduleAt('');
  }

  const fields = check?.columns ?? (table ? table.headers.map((h) => ({ key: h, label: h })) : []);
  const overCapacity = check?.sender && check.wouldSend > check.sender.capacityToday;
  const canSend = !!check && check.wouldSend > 0 && !check.unknownVariables.length && check.sender?.status === 'CONNECTED' && !sending && !checking;

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
                className="w-full font-mono text-sm"
              />
            )}
            {source === 'file' && (
              <label className="flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed p-6 text-sm text-muted-foreground hover:border-primary hover:text-primary">
                <span>{table && source === 'file' ? table.label : 'Choose a .csv or .xlsx file'}</span>
                <span className="text-[11px]">The first row must be the column names (Name, Email, …)</span>
                <input type="file" accept=".csv,.xlsx" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              </label>
            )}
            {source === 'dataset' && (
              <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} className="w-full text-sm">
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
              <select value={segmentId} onChange={(e) => setSegmentId(e.target.value)} className="w-full text-sm">
                <option value="">Choose a segment…</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}

            {parsing && <p className="mt-2 text-xs text-muted-foreground">Reading the list…</p>}
            {table && (source === 'paste' || source === 'file') && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="text-success">✓ {table.rows.length} rows</span>
                <span>· columns: {table.headers.join(', ')}</span>
                {table.headers.length > 1 && (
                  <label className="ml-auto flex items-center gap-1">
                    Email column
                    <select value={emailHeader} onChange={(e) => setEmailHeader(e.target.value)} className="!w-auto !py-0.5 text-xs">
                      <option value="">Auto-detect</option>
                      {table.headers.map((h) => (
                        <option key={h}>{h}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </section>

          <section className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">2. The email</h2>
              <div className="flex rounded-full border border-border p-0.5 text-[11px]">
                <button onClick={() => setFormat('text')} className={`rounded-full px-2 py-0.5 ${format === 'text' ? 'bg-foreground text-background' : 'text-muted-foreground'}`}>Simple</button>
                <button onClick={() => setFormat('html')} className={`rounded-full px-2 py-0.5 ${format === 'html' ? 'bg-foreground text-background' : 'text-muted-foreground'}`}>HTML</button>
              </div>
            </div>
            <input
              ref={subjectRef}
              value={subject}
              onFocus={() => setLastFocus('subject')}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject, e.g. {{Name}}, your interview is confirmed"
              className="mb-2 w-full text-sm"
            />
            <textarea
              ref={bodyRef}
              value={body}
              onFocus={() => setLastFocus('body')}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              placeholder={format === 'text' ? 'Hi {{Name}},\n\nWrite your message here. Links are clickable automatically.\n\nRegards,\nPlacement Team' : '<p>Hi {{Name}},</p>\n<p>…</p>'}
              className={`w-full text-sm ${format === 'html' ? 'font-mono' : ''}`}
            />
            {fields.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
                <span className="text-muted-foreground">Insert a field:</span>
                {fields.map((f) => (
                  <button key={f.key} onClick={() => insertField(f.key)} className="rounded-full border border-border px-2 py-0.5 hover:border-primary hover:text-primary">
                    {f.label}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              Write a column name in double braces, like <code className="font-mono">{'{{Name}}'}</code>, to personalise. An unsubscribe link is added at the bottom automatically.
            </p>
          </section>

          <details className="rounded-lg border bg-card p-4">
            <summary className="cursor-pointer text-sm font-semibold">3. More options <span className="font-normal text-muted-foreground">(sender name, Cc, schedule, backup mailboxes)</span></summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-muted-foreground">
                From name
                <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Placement Team" className="mt-0.5 w-full text-sm text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground">
                Reply-To (optional)
                <input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="placements@masaischool.com" className="mt-0.5 w-full text-sm text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground">
                Cc on every email
                <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="placements@masaischool.com" className="mt-0.5 w-full text-sm text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground">
                Bcc on every email
                <input value={bcc} onChange={(e) => setBcc(e.target.value)} className="mt-0.5 w-full text-sm text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground">
                Send later (optional)
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="mt-0.5 w-full text-sm text-foreground" />
              </label>
              <div className="text-xs text-muted-foreground">
                Backup mailboxes (if yours hits Google&apos;s daily limit)
                {check?.backups.length ? (
                  <div className="mt-1 space-y-1">
                    {check.backups.map((b) => (
                      <label key={b.id} className="flex items-center gap-2 text-sm text-foreground">
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
                  <p className="mt-1">None available. Teammates offer theirs in Settings → Gmail.</p>
                )}
              </div>
            </div>
          </details>
        </div>

        {/* ── Right: preview, check, send / tracking ── */}
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          {current ? (
            <TrackingCard current={current} stats={stats} onPause={() => control('PAUSE')} onResume={() => control('RESUME')} onNew={startOver} />
          ) : (
            <section className="rounded-lg border bg-card p-4">
              <h2 className="mb-2 text-sm font-semibold">Ready to send?</h2>
              {!recipients || !subject.trim() || !body.trim() ? (
                <p className="text-sm text-muted-foreground">Add who gets it, a subject and a message. The check and preview appear here as you type.</p>
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
                  <button onClick={send} disabled={!canSend} className="btn-primary w-full !py-2.5 text-sm disabled:opacity-50">
                    {sending
                      ? 'Starting…'
                      : check.approval === 'required'
                        ? `Send to ${check.wouldSend} (after admin approval)`
                        : scheduleAt
                          ? `Schedule for ${check.wouldSend} people`
                          : `Send to ${check.wouldSend} ${check.wouldSend === 1 ? 'person' : 'people'}`}
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
                      <Link href={`/campaigns/${s.campaignId}`} className="hover:text-primary">{s.name}</Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{statusWords(s)}</td>
                    <td className="px-3 py-2 text-right">{s.sent}/{s.total}</td>
                    <td className="px-3 py-2 text-right">{s.opened} <span className="text-xs text-muted-foreground">({pct(s.opened, s.sent)}%)</span></td>
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
            <button onClick={onResume} className="btn-secondary !py-1 text-xs">Resume</button>
          ) : (
            <button onClick={onPause} className="btn-secondary !py-1 text-xs">Pause</button>
          )
        ) : null}
        <Link href={`/campaigns/${current.id}`} className="btn-secondary !py-1 text-xs">Full report</Link>
        <Link href="/inbox" className="btn-secondary !py-1 text-xs">Replies in Inbox</Link>
        <button onClick={onNew} className="ml-auto text-xs text-primary hover:underline">New Quick Send</button>
      </div>
    </section>
  );
}
