/**
 * Page-based paging for list APIs: ?page=1&pageSize=50. Every list returns its rows plus
 * `total`, `page`, `pageSize` and `pages`, so the UI can show "Showing 51–100 of 1,016" and a
 * pager (components/ui/ListPager.tsx) instead of silently stopping at the first N rows.
 */
export const PAGE_SIZES = [25, 50, 100, 200] as const;

export interface Paging {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function parsePaging(params: URLSearchParams, defaults: { pageSize?: number; max?: number } = {}): Paging {
  const max = defaults.max ?? 200;
  const size = Math.min(max, Math.max(1, Number(params.get('pageSize')) || defaults.pageSize || 50));
  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
  return { page, pageSize: size, skip: (page - 1) * size, take: size };
}

/** The paging fields every list response carries. */
export function pageInfo(total: number, p: Paging) {
  return { total, page: p.page, pageSize: p.pageSize, pages: Math.max(1, Math.ceil(total / p.pageSize)) };
}
