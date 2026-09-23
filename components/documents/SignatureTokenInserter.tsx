'use client';

import { useState, type RefObject } from 'react';
import { signatureToken, type SignatureAlign } from '@/lib/signing/signature-tokens';

/**
 * Inserts a [[signature]] placement token at the cursor of the content
 * textarea. Signers are signed where their token sits; documents without a
 * token keep the signature on the completion page only.
 */
export function SignatureTokenInserter({
  textareaRef,
  content,
  onChange,
}: {
  textareaRef: RefObject<HTMLTextAreaElement>;
  content: string;
  onChange: (next: string) => void;
}) {
  const [signer, setSigner] = useState(1);
  const [align, setAlign] = useState<SignatureAlign>('left');

  function insert() {
    const token = `<p>${signatureToken(signer, align)}</p>`;
    const el = textareaRef.current;
    const start = el?.selectionStart ?? content.length;
    const end = el?.selectionEnd ?? content.length;
    const needsBreakBefore = start > 0 && content[start - 1] !== '\n';
    const insertion = `${needsBreakBefore ? '\n' : ''}${token}\n`;
    onChange(content.slice(0, start) + insertion + content.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      const caret = start + insertion.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
      <span className="font-medium">Signature placement</span>
      <select value={signer} onChange={(e) => setSigner(Number(e.target.value))} className="!py-0.5 text-xs" aria-label="Signer">
        <option value={1}>Signer 1</option>
        <option value={2}>Signer 2</option>
        <option value={3}>Signer 3</option>
      </select>
      <div className="flex overflow-hidden rounded border" role="group" aria-label="Alignment">
        {(['left', 'center', 'right'] as const).map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => setAlign(a)}
            className={`px-2 py-0.5 capitalize ${align === a ? 'bg-foreground text-background' : 'hover:bg-muted'}`}
          >
            {a}
          </button>
        ))}
      </div>
      <button type="button" onClick={insert} className="btn-secondary !px-2 !py-0.5 text-xs">
        Insert at cursor
      </button>
      <span className="text-muted-foreground">
        Adds <code className="font-mono">{signatureToken(signer, align)}</code> where the signature should appear.
      </span>
    </div>
  );
}
