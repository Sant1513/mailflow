'use client';

import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export type FaqItem = { q: string; a: string };

/** Accessible accordion: each question is a button with aria-expanded controlling a region. */
export function Faq({ items }: { items: FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(0);
  const base = useId();
  return (
    <div className="panel divide-y divide-border-subtle">
      {items.map((item, i) => {
        const on = open === i;
        const btn = `${base}-q${i}`;
        const panel = `${base}-a${i}`;
        return (
          <div key={item.q}>
            <h3>
              <button
                id={btn}
                type="button"
                aria-expanded={on}
                aria-controls={panel}
                onClick={() => setOpen(on ? null : i)}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left font-heading text-[15px] font-semibold text-foreground hover:text-primary sm:px-6"
              >
                {item.q}
                <ChevronDown size={18} aria-hidden className={`shrink-0 text-faint transition-transform duration-300 motion-reduce:transition-none ${on ? 'rotate-180' : ''}`} />
              </button>
            </h3>
            <div id={panel} role="region" aria-labelledby={btn} hidden={!on} className="px-5 pb-5 text-sm leading-relaxed text-muted-foreground sm:px-6">
              {item.a}
            </div>
          </div>
        );
      })}
    </div>
  );
}
