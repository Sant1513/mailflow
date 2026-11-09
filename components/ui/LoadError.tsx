'use client';

import Link from 'next/link';

/**
 * What a page shows when its data could not be loaded (instead of "Loading…" forever):
 * the reason, Try again, and a way back.
 */
export function LoadError({ message, onRetry, backHref, backLabel = 'Back' }: { message: string; onRetry?: () => void; backHref?: string; backLabel?: string }) {
  return (
    <div className="p-6">
      <div className="max-w-xl rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" role="alert">
        <p>{message}</p>
        <div className="mt-3 flex gap-3">
          {onRetry && <button type="button" onClick={onRetry} className="font-medium underline">Try again</button>}
          {backHref && <Link href={backHref} className="font-medium underline">{backLabel}</Link>}
        </div>
      </div>
    </div>
  );
}

/** A friendly reason from a failed response. */
export async function loadErrorMessage(res: Response | null, what: string): Promise<string> {
  if (!res) return `The ${what} could not be loaded. Check your connection and try again.`;
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 404) return `This ${what} was not found, or you don't have access to it.`;
  if (res.status === 403) return j.error ?? `You don't have access to this ${what}.`;
  return j.error ?? `The ${what} could not be loaded (${res.status}).`;
}
