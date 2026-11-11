'use client';

import { useId, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

export type FaqItem = { q: string; a: string };
export type FaqGroup = { id: string; label: string; items: FaqItem[] };

/**
 * FAQ by category: a tab row in the page's Mail | Sign switcher style (sliding pill, arrow keys,
 * Home/End), then an accessible accordion for the chosen category. The tab row scrolls sideways
 * on phones.
 */
export function Faq({ groups }: { groups: FaqGroup[] }) {
  const [active, setActive] = useState(groups[0]?.id ?? '');
  const [open, setOpen] = useState<number | null>(0);
  const reduce = useReducedMotion();
  const base = useId();
  const group = groups.find((g) => g.id === active) ?? groups[0];
  if (!group) return null;

  const choose = (id: string, focus = false) => {
    setActive(id);
    setOpen(0);
    if (focus) document.getElementById(`${base}-tab-${id}`)?.focus();
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const last = groups.length - 1;
    const to = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (to === null) return;
    e.preventDefault();
    choose(groups[to]!.id, true);
  };

  return (
    <div>
      <div className="-mx-4 flex overflow-x-auto px-4 pb-1 sm:mx-0 sm:justify-center sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-label="Question categories" className="segmented shrink-0">
          {groups.map((g, i) => {
            const on = g.id === group.id;
            return (
              <button
                key={g.id}
                id={`${base}-tab-${g.id}`}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls={`${base}-panel`}
                tabIndex={on ? 0 : -1}
                onClick={() => choose(g.id)}
                onKeyDown={(e) => onKey(e, i)}
                className={`relative whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${on ? 'text-white' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {on && (
                  <motion.span
                    layoutId={`${base}-faq-pill`}
                    className="nav-pill absolute inset-0 rounded-full"
                    transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 36 }}
                  />
                )}
                <span className="relative">
                  {g.label}
                  <span className={`ml-1.5 text-xs ${on ? 'text-white/70' : 'text-faint'}`}>{g.items.length}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${group.id}`} className="panel mt-8 divide-y divide-border-subtle">
        {group.items.map((item, i) => {
          const on = open === i;
          const btn = `${base}-${group.id}-q${i}`;
          const panel = `${base}-${group.id}-a${i}`;
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
    </div>
  );
}
