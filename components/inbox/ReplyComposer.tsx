'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EmailPreview } from '@/components/email-preview/EmailPreview';
import { ReplyAssistant } from '@/components/ai/ReplyAssistant';
import { formatHtml } from '@/lib/templates/format';
import { htmlToPlainText } from '@/lib/templates/variables';

const CodeEditor = dynamic(() => import('@/components/email-editor/CodeEditor').then((m) => m.CodeEditor), { ssr: false });

export interface ComposerAttachment {
  filename: string;
  mimeType: string;
  base64: string;
  size: number;
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
  const [mode, setMode] = useState<Mode>('write');
  const [html, setHtml] = useState('');
  const [cc, setCc] = useState('');
  const [newThread, setNewThread] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop');
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/snippets?conversationId=${conversationId}`)
      .then((r) => (r.ok ? r.json() : { snippets: [] }))
      .then((j) => setSnippets(j.snippets ?? []))
      .catch(() => undefined);
  }, [conversationId]);

  // Keep the rich editor in sync when html changes from outside (snippet, AI, mode switch).
  useEffect(() => {
    if (mode === 'write' && editorRef.current && editorRef.current.innerHTML !== html) editorRef.current.innerHTML = html;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, html === '' ? '' : null]);

  const syncFromEditor = useCallback(() => {
    if (editorRef.current) setHtml(editorRef.current.innerHTML);
  }, []);

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
      setHtml('');
      if (editorRef.current) editorRef.current.innerHTML = '';
      setCc('');
      setAttachments([]);
      setNewThread(false);
      setMode('write');
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
        <label className="flex items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={newThread} onChange={(e) => setNewThread(e.target.checked)} /> Start a new thread
        </label>
      </div>

      <div className="px-3 pt-2">
        <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="CC (optional, comma-separated)" className="mb-2 w-full !py-1 text-xs" />
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
            <CodeEditor value={html} onChange={setHtml} language="html" />
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
