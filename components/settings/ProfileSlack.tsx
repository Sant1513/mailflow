'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Each person sets their own Slack member ID so assignment notifications can @mention them. */
export function ProfileSlack() {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : { me: null }))
      .then((j) => {
        setValue(j.me?.slackUserId ?? '');
        setSaved(j.me?.slackUserId ?? '');
      })
      .catch(() => undefined);
  }, []);

  async function save() {
    setBusy(true);
    const res = await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slackUserId: value.trim() }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return toast.error(j.error ?? j.issues?.[0]?.message ?? 'Could not save');
    setSaved(j.me?.slackUserId ?? '');
    toast.success(value.trim() ? 'Slack ID saved — you will be @mentioned on assignments' : 'Slack ID cleared');
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium">Slack member ID</label>
      <div className="flex gap-2">
        <input value={value} onChange={(e) => setValue(e.target.value.toUpperCase())} placeholder="U04ABCDEF" className="w-48 font-mono text-sm" />
        <button onClick={save} disabled={busy || value.trim() === (saved ?? '')} className="btn-primary !py-1.5 text-xs">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        In Slack: your profile → ⋯ → <em>Copy member ID</em>. Used to mention you when a conversation is assigned to you or resolved.
      </p>
    </div>
  );
}
