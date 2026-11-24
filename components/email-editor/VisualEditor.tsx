'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { normalizeHref } from '@/lib/email/links';
import { EMAIL_FONT_SIZES, EMAIL_FONTS, isFullDocument } from '@/lib/editor/convert';
import { addFontFallbacks, applyPixelSize } from '@/lib/editor/dom';
import { BLOCKS, starterLayout } from '@/lib/templates/emailBlocks';
import { checkEmailStandards } from '@/lib/templates/emailStandards';

/**
 * The template Visual editor: the template's own HTML (with its own CSS) shown as the recipient will see it, edited in place.
 * Nothing is regenerated or reformatted: what is not touched stays exactly as written, so a designed email keeps its layout
 * and styles. Merge fields ({{Name}}) are ordinary text and stay as they are.
 *
 * How it stays safe and exact:
 *   - the page is shown in a sandboxed frame (no scripts run, whatever the template contains);
 *   - the CSS tab's styles are shown in the frame but never written into the HTML (they stay in their own field);
 *   - the editing helpers added to the frame are removed again before the HTML is handed back;
 *   - scripts, frames and event-handler attributes are dropped on the way out.
 * A bar of email standards (see lib/templates/emailStandards.ts) tells what to fix as you build.
 */

export interface VisualEditorHandle {
  insertText(text: string): void;
}

const EDIT_STYLE = `body{cursor:text}img{cursor:pointer}a{cursor:text}img.mf-selected{outline:2px solid #e5173f;outline-offset:2px}`;

/** The document shown in the frame: the template as written, plus the CSS tab and the editing helpers (both removed on the way out). */
function buildDoc(html: string, css: string): string {
  const source = isFullDocument(html) || /<\s*(!doctype|html)\b/i.test(html) ? html : `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const add = (attr: string, text: string) => {
    const s = doc.createElement('style');
    s.setAttribute(attr, '');
    s.textContent = text;
    doc.head.appendChild(s);
  };
  if (css.trim()) add('data-mf-css', css);
  add('data-mf-edit', EDIT_STYLE);
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

const doctypeOf = (html: string) => /^\s*(<!doctype[^>]*>)/i.exec(html)?.[1] ?? '<!DOCTYPE html>';

/** The edited document back as the template's HTML: helpers removed, nothing unsafe kept; a fragment stays a fragment. */
function serialize(doc: Document, original: string): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  root.querySelectorAll('style[data-mf-css], style[data-mf-edit]').forEach((n) => n.remove());
  root.querySelectorAll('script, iframe, object, embed').forEach((n) => n.remove());
  root.querySelectorAll('.mf-selected').forEach((n) => {
    n.classList.remove('mf-selected');
    if (!n.getAttribute('class')) n.removeAttribute('class');
  });
  root.querySelectorAll('*').forEach((n) => {
    for (const a of Array.from(n.attributes)) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
  });
  const full = /<\s*html\b/i.test(original) || isFullDocument(original);
  if (!full) return root.querySelector('body')?.innerHTML.trim() ?? '';
  return `${doctypeOf(original)}\n${root.outerHTML}\n`;
}

const Btn = ({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) => (
  <button type="button" title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className="h-7 min-w-7 rounded border border-transparent px-1.5 text-xs hover:bg-elevated">
    {children}
  </button>
);
const Sep = () => <span className="mx-1 h-5 w-px bg-border" aria-hidden />;

export const VisualEditor = forwardRef<VisualEditorHandle, { html: string; css: string; onChange: (html: string) => void; columns?: string[] }>(function VisualEditor({ html, css, onChange, columns = [] }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const lastEmitted = useRef(html);
  const lastCss = useRef(css);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [srcDoc, setSrcDoc] = useState('');
  const [image, setImage] = useState<{ src: string; alt: string; width: string; href: string } | null>(null);
  const [showStandards, setShowStandards] = useState(true);
  const originalRef = useRef(html);
  originalRef.current = html;

  // Show (again) whenever the HTML or CSS changes from outside this editor: the code tab, a loaded version, the AI writer.
  useEffect(() => {
    if (html.trim() && (html !== lastEmitted.current || css !== lastCss.current)) {
      lastEmitted.current = html;
      lastCss.current = css;
      setSrcDoc(buildDoc(html, css));
    } else if (!srcDoc && html.trim()) {
      setSrcDoc(buildDoc(html, css));
    } else if (!html.trim()) {
      setSrcDoc('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, css]);

  const doc = () => frame.current?.contentDocument ?? null;

  const emit = useCallback(() => {
    const d = doc();
    if (!d) return;
    const out = serialize(d, originalRef.current);
    lastEmitted.current = out;
    onChange(out);
  }, [onChange]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(emit, 250);
  }, [emit]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const selectImage = useCallback((img: HTMLImageElement | null) => {
    const d = doc();
    d?.querySelectorAll('img.mf-selected').forEach((n) => n.classList.remove('mf-selected'));
    if (!img) return setImage(null);
    img.classList.add('mf-selected');
    const a = img.closest('a');
    setImage({ src: img.getAttribute('src') ?? '', alt: img.getAttribute('alt') ?? '', width: img.getAttribute('width') ?? '', href: a?.getAttribute('href') ?? '' });
  }, []);

  function onLoad() {
    const d = doc();
    if (!d) return;
    d.designMode = 'on';
    d.execCommand('styleWithCSS', false, 'true');
    d.execCommand('defaultParagraphSeparator', false, 'p');
    d.addEventListener('input', schedule);
    d.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      selectImage(t.tagName === 'IMG' ? (t as HTMLImageElement) : null);
    });
  }

  function exec(command: string, value?: string) {
    const d = doc();
    if (!d) return;
    frame.current?.contentWindow?.focus();
    d.execCommand('styleWithCSS', false, 'true');
    d.execCommand(command, false, value);
    schedule();
  }

  function applyFont(name: string) {
    if (!name) return;
    exec('fontName', name);
    const d = doc();
    if (d?.body) addFontFallbacks(d.body, name);
    schedule();
  }
  function applySize(px: string) {
    if (!px) return;
    exec('fontSize', '7');
    const d = doc();
    if (d?.body) applyPixelSize(d.body, px);
    schedule();
  }

  function insertLink() {
    const d = doc();
    const current = d?.getSelection()?.anchorNode?.parentElement?.closest('a')?.getAttribute('href') ?? '';
    const typed = prompt('Link address (https://…, mailto:…, tel:… or a merge field such as {{ApplyLink}})', current)?.trim();
    if (typed === undefined || typed === null) return;
    if (!typed) return exec('unlink');
    const url = /^(mailto:|tel:|#|\{\{)/i.test(typed) ? typed : normalizeHref(typed);
    if (!url) return toast.error('That does not look like a web address.');
    exec('createLink', url);
  }

  function insertBlock(id: string) {
    const block = BLOCKS.find((b) => b.id === id);
    const d = doc();
    if (!block || !d) return;
    frame.current?.contentWindow?.focus();
    const sel = d.getSelection();
    // A block is added after the selection, never over it (inserting over a selection would delete the text).
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) sel.collapseToEnd();
    const anchor = sel?.anchorNode ?? null;
    const anchorEl = anchor && anchor.nodeType === 1 ? (anchor as Element) : anchor?.parentElement ?? null;
    // Only at a cursor that is inside a content cell: a cursor on the page itself (outside the card) falls back to the card.
    const inBody = !!sel && sel.rangeCount > 0 && !!anchorEl && d.body.contains(anchorEl) && !!anchorEl.closest('td');
    const markup = block.html();
    if (inBody) {
      d.execCommand('insertHTML', false, markup);
    } else {
      // No cursor yet: add it at the end of the main content cell (the card), not after the page.
      const cells = Array.from(d.body.querySelectorAll<HTMLElement>('td[style*="font-family"]'));
      const target = cells[cells.length - 1] ?? d.body;
      target.insertAdjacentHTML('beforeend', markup);
    }
    schedule();
  }

  const insertText = useCallback((text: string) => {
    const d = doc();
    if (!d) return;
    frame.current?.contentWindow?.focus();
    d.execCommand('insertText', false, text);
    schedule();
  }, [schedule]);
  useImperativeHandle(ref, () => ({ insertText }), [insertText]);

  function updateImage(patch: Partial<{ src: string; alt: string; width: string; href: string }>) {
    const d = doc();
    const img = d?.querySelector<HTMLImageElement>('img.mf-selected');
    if (!img || !d) return;
    const next = { ...(image ?? { src: '', alt: '', width: '', href: '' }), ...patch };
    setImage(next);
    if (patch.src !== undefined) img.setAttribute('src', next.src);
    if (patch.alt !== undefined) img.setAttribute('alt', next.alt);
    if (patch.width !== undefined) {
      if (next.width) {
        img.setAttribute('width', next.width);
        img.style.maxWidth = `${next.width}px`;
      } else img.removeAttribute('width');
    }
    if (patch.href !== undefined) {
      const a = img.closest('a');
      if (next.href && a) a.setAttribute('href', next.href);
      else if (next.href) {
        const link = d.createElement('a');
        link.setAttribute('href', next.href);
        link.setAttribute('target', '_blank');
        img.replaceWith(link);
        link.appendChild(img);
      } else if (a) a.replaceWith(...Array.from(a.childNodes));
    }
    schedule();
  }

  const standards = useMemo(() => checkEmailStandards(html, css), [html, css]);
  const warnings = standards.items.filter((i) => i.level === 'warn');

  if (!html.trim()) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-visual-empty>
        <div className="max-w-md rounded-lg border bg-card p-5 text-center">
          <h3 className="mb-1 text-sm font-semibold">Start your email</h3>
          <p className="mb-4 text-xs text-muted-foreground">Begin with a ready layout that follows email standards (600px card, mobile-friendly, works in Outlook and Gmail), then edit the text right on the page. Add buttons, images and columns from the Block menu.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" className="btn-primary" onClick={() => onChange(starterLayout())}>Use the email layout</button>
            <button type="button" className="btn-secondary" onClick={() => onChange('<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;">Hi {{Name}},</p>')}>Start blank</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-visual-editor>
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-1.5 py-1">
        <select aria-label="Font" className="!w-auto !py-0.5 text-[11px]" value="" onChange={(e) => applyFont(e.target.value)}>
          <option value="">Font</option>
          {EMAIL_FONTS.map((f) => <option key={f.name} value={f.name} style={{ fontFamily: f.name }}>{f.name}</option>)}
        </select>
        <select aria-label="Size" className="!w-auto !py-0.5 text-[11px]" value="" onChange={(e) => applySize(e.target.value)}>
          <option value="">Size</option>
          {EMAIL_FONT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="Style" className="!w-auto !py-0.5 text-[11px]" value="" onChange={(e) => { if (e.target.value) exec('formatBlock', e.target.value); }}>
          <option value="">Style</option>
          <option value="p">Paragraph</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
        </select>
        <Sep />
        <Btn title="Bold" onClick={() => exec('bold')}><b>B</b></Btn>
        <Btn title="Italic" onClick={() => exec('italic')}><i>I</i></Btn>
        <Btn title="Underline" onClick={() => exec('underline')}><u>U</u></Btn>
        <Btn title="Strikethrough" onClick={() => exec('strikeThrough')}><s>S</s></Btn>
        <Sep />
        <label title="Text colour" className="flex h-7 items-center gap-0.5 rounded px-1 text-xs hover:bg-elevated">A<input type="color" aria-label="Text colour" defaultValue="#1a1a1a" onChange={(e) => exec('foreColor', e.target.value)} className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0" /></label>
        <label title="Highlight colour" className="flex h-7 items-center gap-0.5 rounded px-1 text-xs hover:bg-elevated"><span style={{ background: '#fff176', padding: '0 3px', color: '#000' }}>ab</span><input type="color" aria-label="Highlight colour" defaultValue="#fff176" onChange={(e) => exec('hiliteColor', e.target.value)} className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0" /></label>
        <Sep />
        <Btn title="Align left" onClick={() => exec('justifyLeft')}>⇤</Btn>
        <Btn title="Centre" onClick={() => exec('justifyCenter')}>↔</Btn>
        <Btn title="Align right" onClick={() => exec('justifyRight')}>⇥</Btn>
        <Sep />
        <Btn title="Bulleted list" onClick={() => exec('insertUnorderedList')}>•≡</Btn>
        <Btn title="Numbered list" onClick={() => exec('insertOrderedList')}>1≡</Btn>
        <Btn title="Link" onClick={insertLink}>🔗</Btn>
        <Btn title="Clear formatting" onClick={() => exec('removeFormat')}>Tx</Btn>
        <Btn title="Undo" onClick={() => exec('undo')}>↶</Btn>
        <Btn title="Redo" onClick={() => exec('redo')}>↷</Btn>
        <Sep />
        <select aria-label="Add a block" className="!w-auto !py-0.5 text-[11px]" value="" onChange={(e) => { insertBlock(e.target.value); e.target.value = ''; }}>
          <option value="">＋ Block</option>
          {BLOCKS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
        {columns.length > 0 && (
          <select aria-label="Insert a field" className="!w-auto !py-0.5 text-[11px]" value="" onChange={(e) => { if (e.target.value) insertText(`{{${e.target.value}}}`); e.target.value = ''; }}>
            <option value="">＋ Field</option>
            {columns.map((c) => <option key={c} value={c}>{`{{${c}}}`}</option>)}
          </select>
        )}
      </div>

      {image && (
        <div className="flex flex-wrap items-end gap-2 border-b bg-card px-2 py-1.5 text-[11px]" data-image-panel>
          <span className="font-semibold">Image</span>
          <label className="flex flex-col">Address<input value={image.src} onChange={(e) => updateImage({ src: e.target.value })} className="!w-56 !py-0.5" /></label>
          <label className="flex flex-col">Alt text <span className="text-muted-foreground">(describe it)</span><input value={image.alt} onChange={(e) => updateImage({ alt: e.target.value })} className="!w-48 !py-0.5" /></label>
          <label className="flex flex-col">Width (px)<input value={image.width} onChange={(e) => updateImage({ width: e.target.value.replace(/[^0-9]/g, '') })} className="!w-16 !py-0.5" /></label>
          <label className="flex flex-col">Links to<input value={image.href} onChange={(e) => updateImage({ href: e.target.value })} className="!w-48 !py-0.5" placeholder="https://" /></label>
          <button type="button" className="btn-secondary !py-0.5 text-[11px]" onClick={() => selectImage(null)}>Done</button>
        </div>
      )}

      <div className="min-h-0 flex-1 bg-muted">
        <iframe ref={frame} title="Email visual editor" srcDoc={srcDoc} sandbox="allow-same-origin" onLoad={onLoad} className="h-full w-full border-0 bg-white" />
      </div>

      <div className="shrink-0 border-t bg-card px-2 py-1 text-[11px]" data-standards>
        <button type="button" onClick={() => setShowStandards((v) => !v)} className="flex w-full items-center gap-2 text-left">
          <span className={`font-semibold ${warnings.length ? 'text-warning' : 'text-success'}`}>{warnings.length ? `${warnings.length} to fix for email standards` : '✓ Meets email standards'}</span>
          <span className="text-muted-foreground">{standards.items.length - warnings.length} of {standards.items.length} checks passed · {showStandards ? 'hide' : 'show'}</span>
        </button>
        {showStandards && warnings.length > 0 && (
          <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto">
            {warnings.map((w) => (
              <li key={w.id}><span className="font-bold text-warning">!</span> <b>{w.label}</b>{w.detail ? <span className="text-muted-foreground"> — {w.detail}</span> : null}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});
