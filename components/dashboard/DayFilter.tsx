'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const PRESETS = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
];

export function DayFilter({ current }: { current: number }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function href(days: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('days', String(days));
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
      {PRESETS.map((p) => (
        <Link
          key={p.value}
          href={href(p.value)}
          className={`rounded-md px-3 py-1 text-sm font-medium transition ${
            current === p.value
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-elevated hover:text-foreground'
          }`}
        >
          {p.label}
        </Link>
      ))}
    </div>
  );
}
