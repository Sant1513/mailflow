'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EmailPreview } from '@/components/email-preview/EmailPreview';
import { ReplyAssistant } from '@/components/ai/ReplyAssistant';
import { formatHtml } from '@/lib/templates/format';
import { htmlToPlainText } from '@/lib/templates/variables';

interface ContactSuggestion { id: string; name: string | null; primaryEmail: string; }

function useContactSuggestions(query: string) {
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (query.length < 2) { setSuggestions([]); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contacts?q=${encodeURIComponent(query)}`);
        if (!res.ok) return;
        const { contacts } = await res.json();
        setSuggestions((contacts as ContactSuggestion[]).slice(0, 6));
      } catch { /* silent */ }
    }, 200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]);

  return suggestions;
}

const CodeEditor = dynamic(() => import('@/components/email-editor/CodeEditor').then((m) => m.CodeEditor), { ssr: false });

export interface ComposerAttachment {
  filename: string;
  mimeType: string;
  base64: string;
  size: number;
}

interface SignedDocSummary {
  id: string;
  title: string;
  signedAt: string;
  recipientName: string;
}

export interface ComposerPayload {
  html: string;
  plainText: string;
  cc: string[];
  newThread: boolean;
  attachments: { filename: string; mimeType: string; base64: string }[];
}

interface Snippet {
  id: string;
  name: string;
  html: string;
  rendered: string | null;
  missing: string[];
}

const MAX_TOTAL = 4 * 1024 * 1024;
const MODES = ['write', 'html', 'preview'] as const;
type Mode = (typeof MODES)[number];

function textToParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * §53 reply composer. One HTML source of truth edited three ways: Write
 * (rich text), HTML (code), Preview (the exact email in a resizable frame).
 * Attachments ride along as base64 and become real MIME parts server-side.
 * Nothing is sent until the Send button.
 */
export function ReplyComposer({
  conversationId,
  recipientEmail,
  fromEmail,
  fromName,
  subject,
  busy,
  onSend,
}: {
  conversationId: string;
  recipientEmail: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  busy: boolean;
  onSend: (payload: ComposerPayload) => Promise<boolean>;
}) {
  const DRAFT_KEY = `draft:${conversationId}`;

  const [mode, setMode] = useState<Mode>('write');
  const [html, setHtml] = useState('');
  const [cc, setCc] = useState('');
  const [newThread, setNewThread] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [showDocPanel, setShowDocPanel] = useState(false);
  const [docTab, setDocTab] = useState<'current' | 'old'>('current');
  const [signedDocs, setSignedDocs] = useState<SignedDocSummary[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop');
  const [hasDraft, setHasDraft] = useState(false);
  const [ccQuery, setCcQuery] = useState('');
  const [suggOpen, setSuggOpen] = useState(false);
  const [suggIdx, setSuggIdx] = useState(0);
  const [scheduleFor, setScheduleFor] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [scheduledReplyId, setScheduledReplyId] = useState<string | null>(null);
  const ccRef = useRef<HTMLInputElement>(null);
  const suggestions = useContactSuggestions(ccQuery);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derive the active token being typed (text after last comma/semicolon).
  function activeToken(value: string) {
    const parts = value.split(/[,;]/);
    return (parts[parts.length - 1] ?? '').trimStart();
  }

  function handleCcChange(value: string) {
    setCc(value);
    scheduleDraftSave(html, value);
    const token = activeToken(value);
    setCcQuery(token);
    setSuggOpen(token.length >= 2);
    setSuggIdx(0);
  }

  function pickSuggestion(email: string) {
    const parts = cc.split(/[,;]/);
    parts[parts.length - 1] = email;
    const next = parts.join(', ') + ', ';
    setCc(next);
    scheduleDraftSave(html, next);
    setCcQuery('');
    setSuggOpen(false);
    setTimeout(() => { ccRef.current?.focus(); }, 0);
  }

  function handleCcKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!suggOpen || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSuggIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      const s = suggestions[suggIdx];
      if (s) { e.preventDefault(); pickSuggestion(s.primaryEmail); }
    } else if (e.key === 'Escape') { setSuggOpen(false); }
  }

  // Restore draft or inject signature on mount.
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const saved = localStorage.getItem(DRAFT_KEY);
        if (saved) {
          const { html: draftHtml, cc: draftCc } = JSON.parse(saved) as { html: string; cc: string };
          if (!cancelled && draftHtml) {
            setHtml(draftHtml);
            setCc(draftCc ?? '');
            setHasDraft(true);
            return;
          }
        }
      } catch { /* ignore bad localStorage */ }
      // No draft — fetch signature and seed the editor.
      try {
        const res = await fetch('/api/profile');
        if (!cancelled && res.ok) {
          const { user } = await res.json();
          if (user.emailSignature) {
            const sig = `<p></p><p>--</p>${user.emailSignature
              .split(/\n{2,}/)
              .map((p: string) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
              .join('')}`;
            setHtml(sig);
          }
        }
      } catch { /* no-op */ }
    }
    init();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch(`/api/snippets?conversationId=${conversationId}`)
      .then((r) => (r.ok ? r.json() : { snippets: [] }))
      .then((j) => setSnippets(j.snippets ?? []))
      .catch(() => undefined);
  }, [conversationId]);

  // Autosave draft to localStorage with 1s debounce.
  function scheduleDraftSave(nextHtml: string, nextCc: string) {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      try {
        if (nextHtml.replace(/<[^>]+>/g, '').trim()) {
          localStorage.setItem(DRAFT_KEY, JSON.stringify({ html: nextHtml, cc: nextCc }));
        } else {
          localStorage.removeItem(DRAFT_KEY);
        }
      } catch { /* full */ }
    }, 1000);
  }

  function discardDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* no-op */ }
    setHtml('');
    setCc('');
    setHasDraft(false);
    if (editorRef.current) editorRef.current.innerHTML = '';
    // Re-fetch signature.
    fetch('/api/profile').then((r) => r.json()).then(({ user }) => {
      if (user.emailSignature) {
        const sig = `<p></p><p>--</p>${user.emailSignature.split(/\n{2,}/).map((p: string) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}`;
        setHtml(sig);
        if (editorRef.current) editorRef.current.innerHTML = sig;
      }
    }).catch(() => undefined);
  }

  // Keep the rich editor in sync when html changes from outside (snippet, AI, mode switch).
  useEffect(() => {
    if (mode === 'write' && editorRef.current && editorRef.current.innerHTML !== html) editorRef.current.innerHTML = html;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, html === '' ? '' : null]);

  const syncFromEditor = useCallback(() => {
    if (editorRef.current) {
      const next = editorRef.current.innerHTML;
      setHtml(next);
      scheduleDraftSave(next, cc);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cc]);

  function switchMode(next: Mode) {
    if (mode === 'write') syncFromEditor();
    if (next === 'html' && mode !== 'html') setHtml((h) => formatHtml(h));
    setMode(next);
    if (next === 'write') setTimeout(() => editorRef.current && (editorRef.current.innerHTML = html), 0);
  }

  function exec(command: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    syncFromEditor();
  }

  function insertLink() {
    const url = prompt('Link URL (https://…)');
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return toast.error('Links must start with http:// or https://');
    const sel = window.getSelection();
    const hasSelection = sel && sel.toString().trim().length > 0 && editorRef.current?.contains(sel.anchorNode);
    if (mode === 'write' && hasSelection) exec('createLink', url);
    else {
      const text = prompt('Link text', url) || url;
      const a = `<a href="${url.replace(/"/g, '&quot;')}">${text.replace(/</g, '&lt;')}</a>`;
      if (mode === 'write') exec('insertHTML', a);
      else setHtml((h) => `${h}${a}`);
    }
  }

  function insertHtml(fragment: string) {
    if (mode === 'write') exec('insertHTML', fragment);
    else setHtml((h) => (h.trim() ? `${h}\n${fragment}` : fragment));
  }

  function insertText(text: string) {
    insertHtml(textToParagraphs(text));
  }

  function insertSnippet(s: Snippet) {
    insertHtml(s.rendered ?? s.html);
    if (s.missing.length) toast.warning(`Fill in: ${s.missing.map((m) => `{{${m}}}`).join(', ')}`);
  }

  async function loadSignedDocs() {
    setDocsLoading(true);
    try {
      const res = await fetch(
        `/api/e-sign?search=${encodeURIComponent(recipientEmail)}&status=SIGNED`
      );
      if (res.ok) {
        const json = await res.json();
        setSignedDocs(json.requests ?? []);
      }
    } finally {
      setDocsLoading(false);
    }
  }

  async function attachSignedDoc(id: string, title: string) {
    const res = await fetch(`/api/e-sign/${id}?pdf=1`);
    if (!res.ok) {
      toast.error('Could not load document');
      return;
    }
    const json = await res.json();
    const b64: string | null = json.request?.signedPdfData ?? null;
    if (!b64) {
      toast.error('No signed PDF available for this document');
      return;
    }
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const size = bytes.length;
    const filename = `${title.replace(/\s+/g, '_')}_signed.pdf`;
    const next = [...attachments, { filename, mimeType: 'application/pdf', base64: b64, size }];
    if (next.reduce((n, a) => n + a.size, 0) > MAX_TOTAL) {
      toast.error(
        `The signed PDF (${(size / 1048576).toFixed(1)} MB) would exceed the 4 MB limit.`
      );
      return;
    }
    setAttachments(next);
    toast.success(`${title} attached`);
    setShowDocPanel(false);
  }

  function toggleDocPanel(tab: 'current' | 'old') {
    if (showDocPanel && docTab === tab) {
      setShowDocPanel(false);
      return;
    }
    setDocTab(tab);
    setShowDocPanel(true);
    if (tab === 'current') loadSignedDocs();
  }

  async function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...attachments];
    for (const file of Array.from(list)) {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      next.push({ filename: file.name, mimeType: file.type || 'application/octet-stream', base64, size: file.size });
    }
    const total = next.reduce((n, a) => n + a.size, 0);
    if (total > MAX_TOTAL) {
      toast.error(`Attachments total ${(total / 1048576).toFixed(1)} MB; the limit is 4 MB per reply.`);
      return;
    }
    setAttachments(next);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function scheduleReply() {
    if (!scheduleFor) return toast.error('Pick a date and time first.');
    const scheduledDate = new Date(scheduleFor);
    if (scheduledDate <= new Date()) return toast.error('Scheduled time must be in the future.');
    if (mode === 'write') syncFromEditor();
    const body = mode === 'write' ? (editorRef.current?.innerHTML ?? html) : html;
    if (!body.replace(/<[^>]+>/g, '').trim()) return toast.error('Write something first.');
    setScheduling(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/scheduled-replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduledFor: scheduledDate.toISOString(),
          html: body,
          plainText: htmlToPlainText(body),
          cc: cc.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
          newThread,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to schedule reply');
        return;
      }
      setScheduledAt(scheduleFor);
      setScheduledReplyId(json.reply?.id ?? null);
      setScheduleFor('');
      toast.success(`Reply scheduled for ${new Date(scheduleFor).toLocaleString()}`);
    } finally {
      setScheduling(false);
    }
  }

  async function cancelScheduled() {
    if (!scheduledReplyId) return;
    const res = await fetch(`/api/conversations/${conversationId}/scheduled-replies/${scheduledReplyId}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Failed to cancel scheduled reply');
      return;
    }
    setScheduledAt(null);
    setScheduledReplyId(null);
    toast.success('Scheduled reply cancelled');
  }

  async function send() {
    if (mode === 'write') syncFromEditor();
    const body = mode === 'write' ? (editorRef.current?.innerHTML ?? html) : html;
    if (!body.replace(/<[^>]+>/g, '').trim() && attachments.length === 0) return toast.error('Write something first.');
    const ok = await onSend({
      html: body,
      plainText: htmlToPlainText(body),
      cc: cc.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
      newThread,
      attachments: attachments.map(({ filename, mimeType, base64 }) => ({ filename, mimeType, base64 })),
    });
    if (ok) {
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* no-op */ }
      setHtml('');
      if (editorRef.current) editorRef.current.innerHTML = '';
      setCc('');
      setAttachments([]);
      setNewThread(false);
      setMode('write');
      setHasDraft(false);
    }
  }

  const currentHtml = mode === 'write' ? (editorRef.current?.innerHTML ?? html) : html;
  const totalSize = attachments.reduce((n, a) => n + a.size, 0);

  return (
    <div className="mx-auto mt-4 w-full max-w-3xl rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 text-xs">
        <span className="font-semibold">
          {newThread ? 'New email' : 'Reply'} <span className="font-normal text-muted-foreground">to {recipientEmail} · from {fromEmail}</span>
        </span>
        <div className="flex items-center gap-3">
          {hasDraft && (
            <span className="flex items-center gap-1.5 text-warning">
              Draft restored
              <button onClick={discardDraft} className="underline hover:no-underline">Discard</button>
            </span>
          )}
          <label className="flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={newThread} onChange={(e) => setNewThread(e.target.checked)} /> Start a new thread
          </label>
        </div>
      </div>

      <div className="relative px-3 pt-2">
        <input
          ref={ccRef}
          value={cc}
          onChange={(e) => handleCcChange(e.target.value)}
          onKeyDown={handleCcKeyDown}
          onBlur={() => setTimeout(() => setSuggOpen(false), 150)}
          onFocus={() => { if (ccQuery.length >= 2) setSuggOpen(true); }}
          placeholder="CC (optional, comma-separated)"
          className="mb-2 w-full !py-1 text-xs"
          autoComplete="off"
        />
        {suggOpen && suggestions.length > 0 && (
          <ul className="absolute left-3 right-3 top-[calc(100%-0.5rem)] z-50 max-h-48 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
            {suggestions.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s.primaryEmail); }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${i === suggIdx ? 'bg-primary/10 text-primary' : 'hover:bg-elevated'}`}
                >
                  <span className="font-medium">{s.name ?? s.primaryEmail}</span>
                  {s.name && <span className="text-muted-foreground">{s.primaryEmail}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Mode tabs + toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border-subtle px-3 pb-2">
        <div className="mr-2 flex rounded-full border border-border p-0.5">
          {MODES.map((m) => (
            <button key={m} onClick={() => switchMode(m)} className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize ${mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {m}
            </button>
          ))}
        </div>
        {mode === 'write' && (
          <>
            <ToolButton title="Bold" onClick={() => exec('bold')}><b>B</b></ToolButton>
            <ToolButton title="Italic" onClick={() => exec('italic')}><i>I</i></ToolButton>
            <ToolButton title="Underline" onClick={() => exec('underline')}><u>U</u></ToolButton>
            <ToolButton title="Bulleted list" onClick={() => exec('insertUnorderedList')}>•≡</ToolButton>
            <ToolButton title="Numbered list" onClick={() => exec('insertOrderedList')}>1≡</ToolButton>
            <ToolButton title="Remove formatting" onClick={() => exec('removeFormat')}>Tx</ToolButton>
          </>
        )}
        {mode !== 'preview' && (
          <>
            <ToolButton title="Insert link" onClick={insertLink}>🔗 Link</ToolButton>
            {mode === 'html' && (
              <ToolButton title="Format HTML" onClick={() => setHtml((h) => formatHtml(h))}>Format</ToolButton>
            )}
            {snippets.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  const s = snippets.find((x) => x.id === e.target.value);
                  if (s) insertSnippet(s);
                }}
                className="!w-auto !py-0.5 text-[11px]"
                title="Insert a saved reply"
              >
                <option value="">Insert snippet…</option>
                {snippets.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
          </>
        )}
        <label className="btn-secondary !px-2 !py-0.5 text-[11px] normal-case tracking-normal cursor-pointer" title="Attach files (4 MB total per reply)">
          📎 Attach
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
        </label>
        <button
          type="button"
          title="Attach a signed document (Current Document)"
          onClick={() => toggleDocPanel('current')}
          className={`btn-secondary !px-2 !py-0.5 text-[11px] normal-case tracking-normal ${showDocPanel && docTab === 'current' ? 'bg-primary/10 text-primary border-primary/30' : ''}`}
        >
          📄 Current Document
        </button>
        <button
          type="button"
          title="Upload a document from before e-sign (Old Document)"
          onClick={() => toggleDocPanel('old')}
          className={`btn-secondary !px-2 !py-0.5 text-[11px] normal-case tracking-normal ${showDocPanel && docTab === 'old' ? 'bg-primary/10 text-primary border-primary/30' : ''}`}
        >
          📁 Old Document
        </button>
        <span className="ml-auto">
          <ReplyAssistant conversationId={conversationId} onInsert={insertText} />
        </span>
      </div>

      {/* Editors */}
      <div className="px-3 pt-2">
        {mode === 'write' && (
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={syncFromEditor}
            onBlur={syncFromEditor}
            data-placeholder="Write your reply…"
            className="composer-rich min-h-[140px] w-full rounded border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        )}
        {mode === 'html' && (
          <div className="h-56 overflow-hidden rounded border border-border">
            <CodeEditor value={html} onChange={(v) => { setHtml(v); scheduleDraftSave(v, cc); }} language="html" />
          </div>
        )}
        {mode === 'preview' && (
          <div className="rounded border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-muted px-2 py-1 text-[11px]">
              <span className="truncate">
                <span className="text-muted-foreground">From </span>{fromName} &lt;{fromEmail}&gt; <span className="text-muted-foreground">· Subject </span>{newThread ? subject.replace(/^\s*(re|fwd?)\s*:\s*/i, '') : `Re: ${subject.replace(/^\s*(re|fwd?)\s*:\s*/i, '')}`}
              </span>
              <span className="flex items-center gap-1">
                {(['desktop', 'mobile'] as const).map((m) => (
                  <button key={m} onClick={() => { setPreviewMode(m); setPreviewWidth(null); }} className={`rounded px-2 py-0.5 ${previewMode === m && previewWidth === null ? 'bg-card font-medium' : 'text-muted-foreground'}`}>{m}</button>
                ))}
                <input type="range" min={320} max={1200} step={10} value={previewWidth ?? (previewMode === 'mobile' ? 375 : 700)} onChange={(e) => setPreviewWidth(Number(e.target.value))} className="w-24 accent-[hsl(var(--primary))]" aria-label="Preview width" />
                <span className="w-12 tabular-nums">{previewWidth ?? (previewMode === 'mobile' ? 375 : 700)}px</span>
              </span>
            </div>
            <EmailPreview html={currentHtml || '<p style="color:#888">(empty)</p>'} mode={previewMode} width={previewWidth} />
          </div>
        )}
      </div>

      {/* Document attachment panel — Current Document (e-sign) or Old Document (file upload) */}
      {showDocPanel && (
        <div className="border-t border-border-subtle px-3 py-3">
          <div className="mb-2 flex items-center gap-1 overflow-hidden rounded-md border border-border w-fit">
            <button
              type="button"
              onClick={() => { setDocTab('current'); loadSignedDocs(); }}
              className={`px-3 py-1 text-[11px] font-medium transition ${docTab === 'current' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-elevated'}`}
            >
              Current Document
            </button>
            <button
              type="button"
              onClick={() => setDocTab('old')}
              className={`border-l border-border px-3 py-1 text-[11px] font-medium transition ${docTab === 'old' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-elevated'}`}
            >
              Old Document
            </button>
          </div>

          {docTab === 'current' && (
            <div>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Signed documents from the e-sign system for <strong>{recipientEmail}</strong>
              </p>
              {docsLoading ? (
                <p className="text-[11px] text-muted-foreground">Loading…</p>
              ) : signedDocs.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No signed documents found for this recipient.{' '}
                  <a href="/documents" className="text-primary underline">View all documents →</a>
                </p>
              ) : (
                <ul className="space-y-1">
                  {signedDocs.map((doc) => (
                    <li key={doc.id} className="flex items-center justify-between rounded border border-border bg-card px-2 py-1.5">
                      <div className="min-w-0 text-[11px]">
                        <div className="font-medium truncate">{doc.title}</div>
                        <div className="text-faint">
                          Signed by {doc.recipientName} ·{' '}
                          {new Date(doc.signedAt).toLocaleDateString('en-IN')}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => attachSignedDoc(doc.id, doc.title)}
                        className="ml-2 shrink-0 rounded border border-border px-2 py-0.5 text-[11px] hover:bg-elevated hover:text-primary"
                      >
                        Attach
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {docTab === 'old' && (
            <div>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Upload a document from your computer (PDF, Word, image). This is the pre-e-sign attachment method.
              </p>
              <label className="btn-secondary !px-3 !py-1 text-[11px] normal-case tracking-normal cursor-pointer">
                📎 Choose File
                <input
                  type="file"
                  multiple
                  className="hidden"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                  onChange={(e) => { addFiles(e.target.files); setShowDocPanel(false); }}
                />
              </label>
            </div>
          )}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2 text-[11px]">
          {attachments.map((a, i) => (
            <span key={`${a.filename}-${i}`} className="badge badge-neutral !normal-case !tracking-normal">
              📎 {a.filename} <span className="text-faint">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
              <button onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))} className="ml-1 text-muted-foreground hover:text-destructive" title="Remove">✕</button>
            </span>
          ))}
          <span className="text-faint">{(totalSize / 1048576).toFixed(1)} / 4 MB</span>
        </div>
      )}

      {/* Schedule section */}
      {scheduledAt ? (
        <div className="flex items-center justify-between border-t border-border-subtle px-3 py-2 text-[11px]">
          <span className="text-muted-foreground">
            Scheduled for{' '}
            <strong className="text-foreground">{new Date(scheduledAt).toLocaleString()}</strong>
          </span>
          <button onClick={cancelScheduled} className="rounded border border-destructive/50 px-2 py-0.5 text-destructive hover:bg-destructive/10">
            Cancel scheduled send
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-3 py-2">
          <span className="text-[11px] text-muted-foreground">Schedule:</span>
          <input
            type="datetime-local"
            value={scheduleFor}
            onChange={(e) => setScheduleFor(e.target.value)}
            className="rounded border px-1.5 py-0.5 text-[11px]"
          />
          <button
            onClick={scheduleReply}
            disabled={scheduling || !scheduleFor}
            className="rounded border px-2 py-0.5 text-[11px] hover:bg-elevated disabled:opacity-50"
          >
            {scheduling ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
      )}

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] text-muted-foreground">{newThread ? 'Creates a separate Gmail thread.' : 'Stays in the same Gmail thread.'} Sent as HTML with a plain-text copy.</span>
        <button onClick={send} disabled={busy} className="btn-primary">
          {busy ? 'Sending…' : newThread ? 'Send new email' : 'Send reply'}
        </button>
      </div>
    </div>
  );
}

function ToolButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-elevated hover:text-foreground">
      {children}
    </button>
  );
}
