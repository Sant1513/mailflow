'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';

/**
 * "Download" menu for a send: everyone, only those who opened, or those who were sent the email
 * and haven't opened it. Each item is a plain link to the CSV export (the browser downloads it).
 * `perPerson` false (BCC sends) offers only "Everyone": opens can't be told apart per person.
 */
export function ExportMenu({ href, perPerson = true, label = 'Download' }: { href: string; perPerson?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const items = [
    { filter: 'all', title: 'Everyone', note: 'Sent, opened, replied, bounced, with their columns' },
    ...(perPerson
      ? [
          { filter: 'opened', title: 'Opened', note: 'Only people who opened the email' },
          { filter: 'not_opened', title: 'Not opened', note: 'Sent, but not opened yet' },
        ]
      : []),
  ];

  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm hover:bg-elevated">
        <Download size={14} aria-hidden />
        {label}
        <ChevronDown size={14} aria-hidden className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="panel absolute right-0 z-30 mt-1.5 w-72 p-1.5 shadow-lg">
          {items.map((it) => (
            <a key={it.filter} role="menuitem" href={`${href}?filter=${it.filter}`} download onClick={() => setOpen(false)} className="block rounded-md px-3 py-2 hover:bg-elevated">
              <span className="block text-sm font-medium text-foreground">{it.title} (CSV)</span>
              <span className="block text-xs text-muted-foreground">{it.note}</span>
            </a>
          ))}
          {!perPerson && <p className="px-3 pb-2 pt-1 text-xs text-faint">BCC emails go to many people at once, so opens can’t be split per person.</p>}
        </div>
      )}
    </div>
  );
}
