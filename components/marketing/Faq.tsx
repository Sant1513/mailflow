'use client';

import { useState } from 'react';

export type FaqItem = { q: string; a: string };
export type FaqGroup = { id: string; label: string; items: FaqItem[] };

function Plus() {
  return (
    <svg viewBox="0 0 15 15" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M7.5 1v13M1 7.5h13" />
    </svg>
  );
}

/**
 * "Straight answers": category tab pills (a real tablist: arrow keys, Home/End) and, per
 * category, native <details> rows separated by rules with a + that turns into ×.
 */
export function Faq({ groups }: { groups: FaqGroup[] }) {
  const [active, setActive] = useState(groups[0]?.id ?? '');
  const index = Math.max(0, groups.findIndex((g) => g.id === active));

  function focusTab(i: number) {
    const g = groups[(i + groups.length) % groups.length]!;
    setActive(g.id);
    document.getElementById(`faq-tab-${g.id}`)?.focus();
  }

  return (
    <div>
      <div role="tablist" aria-label="FAQ topics" className="tabs">
        {groups.map((g, i) => {
          const on = g.id === active;
          return (
            <button
              key={g.id}
              id={`faq-tab-${g.id}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`faq-panel-${g.id}`}
              tabIndex={on ? 0 : -1}
              className="tab"
              onClick={() => setActive(g.id)}
              onKeyDown={(e) => {
                const map: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: groups.length - 1 };
                if (e.key in map) {
                  e.preventDefault();
                  focusTab(map[e.key]!);
                }
              }}
            >
              {g.label}
            </button>
          );
        })}
      </div>
      {groups.map((g, gi) => (
        <div
          key={g.id}
          id={`faq-panel-${g.id}`}
          role="tabpanel"
          aria-labelledby={`faq-tab-${g.id}`}
          hidden={gi !== index}
          tabIndex={0}
          className="mt-6 border-t border-[var(--deep-rule)]"
        >
          {g.items.map((item, i) => (
            <details key={item.q} className="faq-row" open={gi === 0 && i === 0 ? true : undefined}>
              <summary>
                {item.q}
                <Plus />
              </summary>
              <p className="faq-a">{item.a}</p>
            </details>
          ))}
        </div>
      ))}
    </div>
  );
}
