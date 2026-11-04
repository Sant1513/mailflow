'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { usePathname, useSearchParams } from 'next/navigation';

const PRESETS = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
];

/** 7 / 30 / 90 days as a segmented pill; the active pill slides between options. */
export function DayFilter({ current, pillId = 'day-filter-pill' }: { current: number; pillId?: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function href(days: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('days', String(days));
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="segmented" role="group" aria-label="Period">
      {PRESETS.map((p) => {
        const on = current === p.value;
        return (
          <Link
            key={p.value}
            href={href(p.value)}
            scroll={false}
            aria-current={on ? 'true' : undefined}
            className={`relative rounded-full px-3 py-1 text-xs font-semibold ${on ? 'text-ink-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {on && <motion.span layoutId={pillId} className="absolute inset-0 rounded-full bg-ink" transition={{ type: 'spring', stiffness: 480, damping: 36 }} />}
            <span className="relative">{p.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
