'use client';

import { useEffect, useRef } from 'react';

/**
 * §104 background sync on open: pulls the mailbox if it has not been synced
 * in the last `staleMinutes`, then calls `onSynced` when something new was
 * stored so the page reloads. A busy mailbox may need several rounds (the
 * server budgets each call); we follow up to `maxRounds` times. Silent on
 * failure — Sync Now remains the explicit path with error messages.
 */
export function useAutoSync(onSynced: () => void, staleMinutes = 2, maxRounds = 4) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    let cancelled = false;
    (async () => {
      let url = `/api/gmail/sync?ifStaleMinutes=${staleMinutes}`;
      for (let round = 0; round < maxRounds && !cancelled; round += 1) {
        const r = await fetch(url, { method: 'POST' }).catch(() => null);
        if (!r || !r.ok) return;
        const j = await r.json().catch(() => null);
        if (!j || j.skipped) return;
        if ((j.stored ?? 0) > 0) onSynced();
        if (!((j.remaining ?? 0) > 0)) return;
        url = '/api/gmail/sync';
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
