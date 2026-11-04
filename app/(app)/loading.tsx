import { Skeleton } from '@/components/motion/Motion';

/**
 * Shown by Next.js while any app page loads: the page's shape in shimmering placeholders
 * (title, a row of cards, a chart and a list), so the screen never sits blank.
 */
export default function Loading() {
  return (
    <div className="space-y-5 p-4 sm:p-6" role="status" aria-label="Loading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64 max-w-[70vw]" />
          <Skeleton className="h-4 w-80 max-w-[80vw]" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28 rounded-full" />
          <Skeleton className="h-9 w-32 rounded-full" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="panel space-y-3 p-4" style={{ animationDelay: `${i * 80}ms` }}>
            <Skeleton className="h-8 w-8 rounded-xl" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="panel space-y-4 p-5 lg:col-span-2">
          <div className="flex justify-between">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-7 w-36 rounded-full" />
          </div>
          <div className="flex h-44 items-end gap-3">
            {[45, 70, 55, 85, 60, 95, 75].map((h, i) => (
              <Skeleton key={i} className="flex-1 rounded-lg" style={{ height: `${h}%` } as React.CSSProperties} />
            ))}
          </div>
        </div>
        <div className="panel flex flex-col items-center justify-center gap-4 p-5">
          <Skeleton className="h-36 w-36 rounded-full" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <div className="panel space-y-3 p-5">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
