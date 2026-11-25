'use client';

import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { SortDir } from '@/lib/ui/sort';

/**
 * A table header you can click to sort. Shows the arrow of the current sort; `aria-sort` for screen readers.
 * `first` is the direction a new column starts with (numbers and dates are most useful biggest/newest first).
 */
export function SortTh<K extends string>({
  label, k, sort, onSort, first = 'asc', align = 'left', className = '',
}: {
  label: string;
  k: K;
  sort: { key: K; dir: SortDir };
  onSort: (key: K, first: SortDir) => void;
  first?: SortDir;
  align?: 'left' | 'right';
  className?: string;
}) {
  const active = sort.key === k;
  const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`px-4 py-2 ${align === 'right' ? 'text-right' : 'text-left'} ${className}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(k, first)}
        data-sort={k}
        className={`inline-flex items-center gap-1 uppercase hover:text-foreground ${align === 'right' ? 'flex-row-reverse' : ''} ${active ? 'text-foreground' : ''}`}
        title={`Sort by ${label}`}
      >
        {label}
        <Icon className={`h-3 w-3 ${active ? '' : 'opacity-40'}`} />
      </button>
    </th>
  );
}
