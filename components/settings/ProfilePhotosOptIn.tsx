'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Status {
  connected: boolean;
  enabled: boolean;
  lastReadAt: string | null;
  mine: number;
  total: number;
  mailboxesOn: number;
}

/**
 * Settings → Gmail → Profile photos. Asks Google for read-only "Other contacts" (people this
 * mailbox has emailed) so their profile photos can show next to their names; it never affects
 * sending. Photos are refreshed weekly; anyone without a photo keeps their initials.
 */
export function ProfilePhotosOptIn() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/profile-photos/status', { cache: 'no-store' }).catch(() => null);
    if (res?.ok) setStatus(await res.json());
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setBusy(true);
    const res = await fetch('/api/profile-photos/status', { method: 'POST' }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    setBusy(false);
    if (res?.ok) toast.success(`Found ${j.photos.toLocaleString()} profile photo${j.photos === 1 ? '' : 's'} among ${j.contacts.toLocaleString()} people this mailbox has emailed.`);
    else toast.error(j?.error ?? 'Could not read the profile photos.');
    load();
  }

  if (!status) return null;
  return (
    <div className="mt-4 rounded-md border bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium text-foreground">Profile photos</div>
          <div className="text-xs text-muted-foreground">
            Show people&apos;s Google profile photos next to their names (Inbox, History, Contacts, Recruiter Bulk Send). People without a photo keep their initials.
          </div>
        </div>
        {status.enabled ? (
          <button type="button" onClick={refresh} disabled={busy} className="btn-secondary !py-1.5 text-xs disabled:opacity-50">
            {busy ? 'Reading…' : 'Refresh now'}
          </button>
        ) : (
          <a href="/api/gmail/connect?with=photos&return=/settings" className="btn-primary !py-1.5 text-xs">
            Turn on profile photos
          </a>
        )}
      </div>
      <div className="mt-2 text-xs text-faint">
        {status.enabled
          ? `On for your mailbox · ${status.mine.toLocaleString()} photos from it${status.lastReadAt ? ` · last read ${new Date(status.lastReadAt).toLocaleString()}` : ' · reading for the first time…'} · refreshed weekly.`
          : 'Google asks you to allow read-only access to "Other contacts" (people you have emailed). Sending and syncing are not affected.'}
        {` ${status.total.toLocaleString()} photos across ${status.mailboxesOn} mailbox${status.mailboxesOn === 1 ? '' : 'es'} in your organization.`}
      </div>
    </div>
  );
}
