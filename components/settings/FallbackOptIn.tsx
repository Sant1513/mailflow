'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * The mailbox owner's consent for their Gmail to be a backup sender on
 * teammates' campaigns (used only when a campaign's own mailbox hits Google's
 * daily limit, is told to slow down, or is disconnected).
 */
export function FallbackOptIn() {
  const [state, setState] = useState<{ mailbox: { emailAddress: string; status: string } | null; allowed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/gmail/fallback')
      .then((r) => (r.ok ? r.json() : null))
      .then(setState)
      .catch(() => undefined);
  }, []);

  if (!state?.mailbox) return null;

  async function toggle(allow: boolean) {
    if (allow && !confirm(`Allow teammates' campaigns to send from ${state!.mailbox!.emailAddress} when their own mailbox can't send? Those emails go out under your address, and replies come to your inbox.`)) return;
    setBusy(true);
    const res = await fetch('/api/gmail/fallback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow }) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast.error(json.error ?? 'Could not save');
      return;
    }
    setState((s) => (s ? { ...s, allowed: allow } : s));
    toast.success(allow ? 'Your mailbox can now be picked as a backup sender.' : 'Your mailbox is no longer available as a backup sender.');
  }

  return (
    <div className="mt-4 rounded-md border p-3">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={state.allowed} disabled={busy} onChange={(e) => toggle(e.target.checked)} className="mt-0.5 accent-primary" />
        <span>
          <span className="font-medium">Allow my mailbox as a backup sender</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Teammates can add {state.mailbox.emailAddress} to a campaign as a backup. It is used only when their own mailbox reaches
            Google&apos;s daily limit, is asked to slow down, or is disconnected. Emails then go out from your address (counting towards
            your daily limit) and replies come to your inbox and to the campaign in MailFlow. You can turn this off at any time.
          </span>
        </span>
      </label>
    </div>
  );
}
