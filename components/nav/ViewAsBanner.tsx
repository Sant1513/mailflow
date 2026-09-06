'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ViewingAs } from '@/lib/auth/session';

/**
 * §9 banner. Rendered by the app layout whenever the server-resolved session
 * carries `viewingAs`, so it cannot be hidden by client state. Exit clears
 * the signed cookie server-side (audited) and refreshes every server
 * component so the scope snaps back to the admin's own workspace.
 */
export function ViewAsBanner({ viewingAs }: { viewingAs: ViewingAs }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function exitView() {
    setBusy(true);
    const res = await fetch('/api/admin/view-as', { method: 'DELETE' });
    if (!res.ok) {
      setBusy(false);
      toast.error('Could not exit the view');
      return;
    }
    toast.success('Back to your own workspace');
    router.push('/admin/workspaces');
    router.refresh();
  }

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-4 border-b border-primary/40 bg-primary/15 px-6 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="eyebrow shrink-0 border-primary/60 bg-primary/20 text-foreground">
          Viewing workspace as
        </span>
        <div className="min-w-0 truncate text-sm">
          <span className="font-heading font-semibold text-foreground">{viewingAs.ownerName}</span>
          <span className="text-muted-foreground"> · {viewingAs.ownerEmail}</span>
          <span className="text-faint"> · {viewingAs.workspaceName}</span>
        </div>
        <span className="hidden text-xs text-muted-foreground sm:inline">Read-only. Every view is audited.</span>
      </div>
      <button onClick={exitView} disabled={busy} className="btn-secondary shrink-0 !py-1.5 text-xs">
        {busy ? 'Exiting…' : 'Exit View'}
      </button>
    </div>
  );
}
