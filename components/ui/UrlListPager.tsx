'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ListPager } from '@/components/ui/ListPager';

/** ListPager for server-rendered lists: the page and page size live in the URL (?page=&pageSize=). */
export function UrlListPager({ page, pageSize, total, noun, className }: { page: number; pageSize: number; total: number; noun?: string; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (next: Record<string, number>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) q.set(k, String(v));
    router.push(`${pathname}?${q.toString()}`);
  };
  return (
    <ListPager
      page={page}
      pageSize={pageSize}
      total={total}
      noun={noun}
      className={className}
      onPage={(p) => go({ page: p })}
      onPageSize={(n) => go({ page: 1, pageSize: n })}
    />
  );
}
