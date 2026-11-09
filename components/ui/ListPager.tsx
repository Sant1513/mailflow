'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

/**
 * The pager under every list: "Showing 51–100 of 1,016 contacts", first / previous / next /
 * last, jump to a page, and rows per page. Shown even on one page so the total is always there.
 */
export function ListPager({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  noun = 'rows',
  sizes = [25, 50, 100, 200],
  className = '',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
  /** Plural name for the total ("contacts"). */
  noun?: string;
  sizes?: readonly number[];
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const [jump, setJump] = useState(String(page));
  useEffect(() => setJump(String(page)), [page]);
  const go = (p: number) => onPage(Math.min(pages, Math.max(1, p)));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  const btn = 'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 px-1 py-2 text-xs text-muted-foreground ${className}`}>
      <span aria-live="polite">
        {total ? (
          <>Showing <b className="text-foreground">{from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')}</b> of <b className="text-foreground">{total.toLocaleString('en-IN')}</b> {noun}</>
        ) : (
          <>No {noun}</>
        )}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {onPageSize && (
          <label className="flex items-center gap-1.5">
            Rows
            <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="rounded-md border border-border bg-card px-1.5 py-1 text-xs" aria-label="Rows per page">
              {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}
        {pages > 1 && (
          <div className="flex items-center gap-1" role="navigation" aria-label="Pages">
            <button type="button" className={btn} disabled={page <= 1} onClick={() => go(1)} aria-label="First page"><ChevronsLeft className="h-4 w-4" /></button>
            <button type="button" className={btn} disabled={page <= 1} onClick={() => go(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(jump);
                if (Number.isFinite(n)) go(Math.round(n));
              }}
              className="flex items-center gap-1 px-1"
            >
              Page
              <input
                value={jump}
                onChange={(e) => setJump(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={() => { const n = Number(jump); if (n && n !== page) go(n); else setJump(String(page)); }}
                inputMode="numeric"
                aria-label="Go to page"
                className="h-8 w-12 rounded-md border border-border bg-card text-center text-xs text-foreground"
              />
              of {pages.toLocaleString('en-IN')}
            </form>
            <button type="button" className={btn} disabled={page >= pages} onClick={() => go(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
            <button type="button" className={btn} disabled={page >= pages} onClick={() => go(pages)} aria-label="Last page"><ChevronsRight className="h-4 w-4" /></button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Paging for a list that is already fully loaded: the current page's rows plus the props for
 * ListPager. Goes back to page 1 when the list's length changes (a filter or reload).
 */
export function useClientPaging<T>(items: readonly T[], initialSize = 25) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);
  useEffect(() => setPage(1), [items.length, pageSize]);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  return {
    rows: items.slice((current - 1) * pageSize, current * pageSize),
    pager: { page: current, pageSize, total: items.length, onPage: setPage, onPageSize: setPageSize },
  };
}
