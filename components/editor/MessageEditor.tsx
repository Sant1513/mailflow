'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { normalizeHref } from '@/lib/email/links';
import { looksLikeHtml } from '@/lib/quickSend/paste';
import { bodyOf, EMAIL_FONT_SIZES, EMAIL_FONTS, htmlToText, isFullDocument, textToHtml } from '@/lib/editor/convert';
import { addFontFallbacks, applyPixelSize } from '@/lib/editor/dom';

/**
 * The message editor used for emails: three views of the same message.
 *   Simple  plain text (blank line = new paragraph; links become clickable when sent)
 *   Rich    a visual editor: font, size, bold / italic / underline / strike, colours, alignment, lists, headings, links…
 *   HTML    the source, for a designed email pasted from elsewhere
 * Simple is format "text"; Rich and HTML are format "html". Switching never loses anything without asking first.
 */
export type MessageFormat = 'text' | 'html';
type View = 'simple' | 'rich' | 'html';

export interface MessageEditorHandle {
  /** Insert text (a merge field such as {{Name}}) where the cursor is. */
  insertText(text: string): void;
  focus(): void;
}

const isRichSafe = (value: string) => !isFullDocument(value);
const initialView = (format: MessageFormat, value: string): View => (format === 'text' ? 'simple' : isRichSafe(value) ? 'rich' : 'html');

const Btn = ({ title, onClick, children, active }: { title: string; onClick: () => void; children: ReactNode; active?: boolean }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    // mouse down must not take the selection away from the text being formatted
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={`h-7 min-w-7 rounded border px-1.5 text-xs hover:bg-elevated ${active ? 'border-primary text-primary' : 'border-transparent text-foreground'}`}
  >
    {children}
  </button>
);

const Sep = () => <span className="mx-1 h-5 w-px bg-border" aria-hidden />;

export const MessageEditor = forwardRef<MessageEditorHandle, {
  id?: string;
  value: string;
  format: MessageFormat;
  onChange: (value: string) => void;
  onFormatChange: (format: MessageFormat) => void;
  onFocus?: () => void;
  rows?: number;
  placeholderText?: string;
  placeholderHtml?: string;
  className?: string;
}>(function MessageEditor({ id, value, format, onChange, onFormatChange, onFocus, rows = 12, placeholderText, placeholderHtml, className = '' }, ref) {
  const [view, setView] = useState<View>(() => initialView(format, value));
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const richRef = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string>(value);
  const savedRange = useRef<Range | null>(null);

  // The parent changed the format or the message from outside (a loaded draft or template): follow it.
  useEffect(() => {
    if (format === 'text' && view !== 'simple') setView('simple');
    else if (format === 'html' && view === 'simple') setView(initialView('html', value));
    else if (view === 'rich' && !isRichSafe(value)) setView('html');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, value]);

  // Keep the visual editor in step with the message when it is changed from outside.
  useEffect(() => {
    const el = richRef.current;
    if (view === 'rich' && el && value !== lastEmitted.current && el.innerHTML !== value) {
      el.innerHTML = value;
      lastEmitted.current = value;
    }
  }, [value, view]);
  useEffect(() => {
    if (view === 'rich' && richRef.current) {
      richRef.current.innerHTML = value;
      lastEmitted.current = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const emit = useCallback((html: string) => {
    // An emptied editor leaves a stray <br> or empty block: treat it as empty.
    const clean = /^(<p>)?(<br\s*\/?>)?(<\/p>)?$/i.test(html.trim()) ? '' : html;
    lastEmitted.current = clean;
    onChange(clean);
  }, [onChange]);

  const sync = useCallback(() => {
    if (richRef.current) emit(richRef.current.innerHTML);
  }, [emit]);

  const remember = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && richRef.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    richRef.current?.focus();
    const sel = window.getSelection();
    if (sel && savedRange.current) { sel.removeAllRanges(); sel.addRange(savedRange.current); }
  };

  function exec(command: string, arg?: string) {
    restore();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand('defaultParagraphSeparator', false, 'p');
    document.execCommand(command, false, arg);
    remember();
    sync();
  }

  function applyFont(name: string) {
    if (!name) return;
    exec('fontName', name);
    if (richRef.current) addFontFallbacks(richRef.current, name);
    sync();
  }

  function applySize(px: string) {
    if (!px) return;
    exec('fontSize', '7'); // the largest legacy size is only a marker: it is replaced with the real pixel size
    if (richRef.current) applyPixelSize(richRef.current, px);
    sync();
  }

  function insertLink() {
    restore();
    const typed = prompt('Link address (for example levelupcareer.in or https://…)')?.trim();
    if (!typed) return;
    const url = normalizeHref(typed) ?? (/^(mailto:|tel:)/i.test(typed) ? typed : null);
    if (!url) return toast.error('That does not look like a web address.');
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) exec('createLink', url);
    else exec('insertHTML', `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>`);
  }

  useImperativeHandle(ref, () => ({
    focus() {
      if (view === 'rich') richRef.current?.focus();
      else areaRef.current?.focus();
    },
    insertText(text: string) {
      if (view === 'rich') {
        restore();
        document.execCommand('insertText', false, text);
        remember();
        sync();
        return;
      }
      const el = areaRef.current;
      const at = el?.selectionStart ?? value.length;
      const end = el?.selectionEnd ?? at;
      onChange(value.slice(0, at) + text + value.slice(end));
      requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + text.length, at + text.length); });
    },
  }), [view, value, onChange, sync]);

  function go(next: View) {
    if (next === view) return;
    if (next === 'simple') {
      if (value.trim() && !confirm('Simple is plain text: fonts, colours, bold and layout will be removed from this message. Continue?')) return;
      onChange(htmlToText(value));
      onFormatChange('text');
    } else if (view === 'simple') {
      onChange(textToHtml(value));
      onFormatChange('html');
    } else if (next === 'rich' && isFullDocument(value)) {
      if (!confirm('This is a fully designed HTML email. The visual editor keeps its content but drops page-level styling and layout. Continue?')) return;
      onChange(bodyOf(value));
    }
    setView(next);
  }

  const tab = (v: View, label: string) => (
    <button type="button" onClick={() => go(v)} className={`rounded-full px-2.5 py-0.5 ${view === v ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>{label}</button>
  );

  return (
    <div className={className} data-message-editor={view}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <div className="flex rounded-full border border-border p-0.5 text-[11px]" role="tablist" aria-label="Editor type">
          {tab('simple', 'Simple')}
          {tab('rich', 'Rich')}
          {tab('html', 'HTML')}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {view === 'simple' ? 'Plain text: links become clickable when sent.' : view === 'rich' ? 'Format it like a document: fonts, colours, lists, links.' : 'The HTML source, for a designed email.'}
        </span>
      </div>

      {view === 'rich' && (
        <div className="overflow-hidden rounded border border-border bg-card">
          <div className="flex flex-wrap items-center gap-0.5 border-b border-border-subtle bg-muted/40 px-1.5 py-1" onMouseDownCapture={remember}>
            <select aria-label="Font" className="!w-auto !py-0.5 text-[11px]" value="" onChange={(e) => applyFont(e.target.value)} onMouseDown={remember}>
              <option value="">Font</option>
              {EMAIL_FONTS.map((f) => <option key={f.name} value={f.name} style={{ fontFamily: f.name }}>{f.name}</option>)}
            </select>
            <select aria-label="Size" className="!w-auto !py-0.5 text-[11px]" value="" onChange={(e) => applySize(e.target.value)} onMouseDown={remember}>
              <option value="">Size</option>
              {EMAIL_FONT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select aria-label="Style" className="!w-auto !py-0.5 text-[11px]" value="" onChange={(e) => { if (e.target.value) exec('formatBlock', e.target.value); }} onMouseDown={remember}>
              <option value="">Style</option>
              <option value="p">Paragraph</option>
              <option value="h1">Heading 1</option>
              <option value="h2">Heading 2</option>
              <option value="h3">Heading 3</option>
              <option value="blockquote">Quote</option>
            </select>
            <Sep />
            <Btn title="Bold" onClick={() => exec('bold')}><b>B</b></Btn>
            <Btn title="Italic" onClick={() => exec('italic')}><i>I</i></Btn>
            <Btn title="Underline" onClick={() => exec('underline')}><u>U</u></Btn>
            <Btn title="Strikethrough" onClick={() => exec('strikeThrough')}><s>S</s></Btn>
            <Sep />
            <label title="Text colour" className="flex h-7 items-center gap-0.5 rounded px-1 text-xs hover:bg-elevated" onMouseDown={remember}>
              A<input type="color" aria-label="Text colour" defaultValue="#1a1a1a" onChange={(e) => exec('foreColor', e.target.value)} className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0" />
            </label>
            <label title="Highlight colour" className="flex h-7 items-center gap-0.5 rounded px-1 text-xs hover:bg-elevated" onMouseDown={remember}>
              <span style={{ background: '#fff176', padding: '0 3px', color: '#000' }}>ab</span><input type="color" aria-label="Highlight colour" defaultValue="#fff176" onChange={(e) => exec('hiliteColor', e.target.value)} className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0" />
            </label>
            <Sep />
            <Btn title="Align left" onClick={() => exec('justifyLeft')}>⇤</Btn>
            <Btn title="Centre" onClick={() => exec('justifyCenter')}>↔</Btn>
            <Btn title="Align right" onClick={() => exec('justifyRight')}>⇥</Btn>
            <Btn title="Justify" onClick={() => exec('justifyFull')}>☰</Btn>
            <Sep />
            <Btn title="Bulleted list" onClick={() => exec('insertUnorderedList')}>•≡</Btn>
            <Btn title="Numbered list" onClick={() => exec('insertOrderedList')}>1≡</Btn>
            <Btn title="Decrease indent" onClick={() => exec('outdent')}>⇤≡</Btn>
            <Btn title="Increase indent" onClick={() => exec('indent')}>≡⇥</Btn>
            <Sep />
            <Btn title="Link" onClick={insertLink}>🔗</Btn>
            <Btn title="Remove link" onClick={() => exec('unlink')}>⛓</Btn>
            <Btn title="Horizontal line" onClick={() => exec('insertHorizontalRule')}>―</Btn>
            <Btn title="Clear formatting" onClick={() => exec('removeFormat')}>Tx</Btn>
            <Sep />
            <Btn title="Undo" onClick={() => exec('undo')}>↶</Btn>
            <Btn title="Redo" onClick={() => exec('redo')}>↷</Btn>
          </div>
          <div
            ref={richRef}
            id={id}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            data-placeholder={placeholderText ?? 'Hi {{Name}},'}
            onFocus={onFocus}
            onInput={sync}
            onBlur={() => { remember(); sync(); }}
            onKeyUp={remember}
            onMouseUp={remember}
            style={{ minHeight: `${Math.max(8, rows) * 1.6}em`, fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 14 }}
            className="composer-rich w-full max-w-none overflow-auto bg-white px-3 py-2 text-[#1a1a1a] focus:outline-none"
          />
        </div>
      )}

      {view !== 'rich' && (
        <textarea
          id={id}
          ref={areaRef}
          value={value}
          rows={rows}
          onFocus={onFocus}
          onChange={(e) => {
            const next = e.target.value;
            // Pasting a designed HTML email into Simple: switch to HTML so it renders, not shows as code.
            if (view === 'simple' && looksLikeHtml(next) && next.length - value.length > 200) {
              onFormatChange('html');
              setView('html');
              toast.success('That looks like an HTML email, so the message is now in HTML mode and will show as designed.');
            }
            onChange(next);
          }}
          placeholder={view === 'simple' ? placeholderText ?? 'Hi {{Name}},\n\nWrite your message here.' : placeholderHtml ?? '<p>Hi {{Name}},</p>\n<p>…</p>'}
          className={`input w-full ${view === 'html' ? 'font-mono text-xs' : ''}`}
        />
      )}
    </div>
  );
});
