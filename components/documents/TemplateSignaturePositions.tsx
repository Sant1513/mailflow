'use client';

import { useState } from 'react';
import { SignaturePlacementEditor, signerColor } from './SignaturePlacementEditor';
import type { SignaturePlacement } from '@/lib/signing/placements';

/** Template-editor card: how many people sign, and where each one signs. */
export function TemplateSignaturePositions({
  title,
  content,
  sampleValues,
  roles,
  value,
  onChange,
}: {
  title: string;
  content: string;
  sampleValues: Record<string, string>;
  /** Signer role names saved on the template, if any. */
  roles: string[];
  value: SignaturePlacement[];
  onChange: (next: SignaturePlacement[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(() =>
    Math.min(3, Math.max(1, roles.length, ...value.map((p) => p.signerIndex))),
  );
  const signers = Array.from({ length: count }, (_, i) => ({ index: i + 1, role: roles[i] || `Signer ${i + 1}` }));
  const active = value.filter((p) => p.signerIndex <= count);

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="eyebrow mb-1">Signature positions</div>
      <p className="mb-3 text-xs text-muted-foreground">
        Drag a box onto the document for each signer and resize it. The signature is drawn inside that box on every signed
        PDF made from this template. Leave empty to keep signatures on the completion page only.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          Signers
          <select value={count} onChange={(e) => setCount(Number(e.target.value))} className="!py-0.5 text-xs">
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!content.trim()}
          className="btn-secondary !px-3 !py-1 text-xs disabled:opacity-50"
          title={content.trim() ? undefined : 'Add document content first'}
        >
          {active.length ? 'Edit positions' : 'Place signatures on document'}
        </button>
        {signers.map((s) => {
          const pages = [...new Set(active.filter((p) => p.signerIndex === s.index).map((p) => p.page + 1))];
          const c = signerColor(s.index);
          return (
            <span key={s.index} className="inline-flex items-center gap-1.5 text-[11px]">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: c.bg, border: `1.5px dashed ${c.border}` }} />
              {s.role}: {pages.length ? `page ${pages.join(', ')}` : <span className="text-muted-foreground">not placed</span>}
            </span>
          );
        })}
      </div>
      {open && (
        <SignaturePlacementEditor
          title={title}
          content={content}
          fieldValues={sampleValues}
          signers={signers}
          value={active}
          onSave={(next) => {
            onChange(next);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
