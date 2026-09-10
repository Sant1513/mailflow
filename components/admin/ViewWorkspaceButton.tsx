'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/**
 * §9 "[ View Workspace ]". Sets the signed view-as cookie via the audited
 * API, then lands on the dashboard scoped to that workspace.
 */
export function ViewWorkspaceButton({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function enter() {
    setBusy(true);
    const res = await fetch('/api/admin/view-as', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBusy(false);
      toast.error(json.error ?? 'Could not open that workspace');
      return;
    }
    if (!json.viewingAs) {
      setBusy(false);
      toast.info('That is your own workspace');
      router.push('/dashboard');
      return;
    }
    router.push('/dashboard');
    router.refresh();
  }

  return (
    <button onClick={enter} disabled={busy} className={className ?? 'btn-secondary !py-1 text-xs'}>
      {busy ? 'Opening…' : 'View Workspace'}
    </button>
  );
}
