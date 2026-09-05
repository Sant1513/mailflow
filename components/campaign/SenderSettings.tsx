'use client';

import { useState } from 'react';
import { toast } from 'sonner';

/**
 * §22 sender settings. The From ADDRESS is intentionally read-only: it is
 * pinned to the connected mailbox so a campaign cannot send under an
 * address the user has not proven they control (§28).
 */
export function SenderSettings({
  campaignId,
  initial,
  senderEmail,
  senderStatus,
  locked,
  onSaved,
}: {
  campaignId: string;
  initial: { fromName: string | null; replyTo: string | null; cc: string[]; bcc: string[] };
  senderEmail: string | null;
  senderStatus: string | null;
  /** A running/completed campaign must not have its headers edited. */
  locked: boolean;
  onSaved: () => void;
}) {
  const [fromName, setFromName] = useState(initial.fromName ?? '');
  const [replyTo, setReplyTo] = useState(initial.replyTo ?? '');
  const [cc, setCc] = useState(initial.cc.join(', '));
  const [bcc, setBcc] = useState(initial.bcc.join(', '));
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const res = await fetch(`/api/campaigns/${campaignId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromName: fromName.trim() || null,
        replyTo: replyTo.trim() || null,
        ccEmails: cc,
        bccEmails: bcc,
      }),
    });
    setSaving(false);
    const json = await res.json();
    if (!res.ok) {
      // Surface the specific validation message (e.g. a malformed address)
      // rather than a generic failure.
      toast.error(json.issues?.[0]?.message ?? json.error ?? 'Could not save sender settings');
      return;
    }
    toast.success('Sender settings saved');
    onSaved();
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">Sender &amp; recipients</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium">From name</label>
          <input
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            disabled={locked}
            placeholder="Placement Team"
            className="w-full rounded-md border px-2 py-1.5 text-sm disabled:bg-muted"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">From address</label>
          <div className="flex items-center gap-2 rounded-md border bg-muted px-2 py-1.5 text-sm text-muted-foreground">
            <span className="truncate">{senderEmail ?? 'No Gmail connected'}</span>
            <span className="ml-auto shrink-0 rounded bg-card px-1.5 py-0.5 text-[10px]">locked</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Always your connected mailbox — a campaign cannot send as someone else.
            {senderStatus && senderStatus !== 'CONNECTED' && (
              <span className="text-warning"> Status: {senderStatus}.</span>
            )}
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">Reply-To</label>
          <input
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            disabled={locked}
            placeholder="placement@masaischool.com"
            className="w-full rounded-md border px-2 py-1.5 text-sm disabled:bg-muted"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Where replies go. Leave empty to reply to the From address.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">CC</label>
          <input
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            disabled={locked}
            placeholder="lead@masaischool.com, ops@masaischool.com"
            className="w-full rounded-md border px-2 py-1.5 text-sm disabled:bg-muted"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium">BCC</label>
          <input
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
            disabled={locked}
            placeholder="archive@masaischool.com"
            className="w-full rounded-md border px-2 py-1.5 text-sm disabled:bg-muted"
          />
          <p className="mt-1 text-[11px] text-warning">
            CC and BCC are added to <strong>every</strong> message in this campaign — one
            address on a 250-recipient campaign means 250 extra emails to that person.
          </p>
        </div>
      </div>

      {!locked && (
        <button
          onClick={save}
          disabled={saving}
          className="mt-3 btn-secondary"
        >
          {saving ? 'Saving…' : 'Save sender settings'}
        </button>
      )}
      {locked && (
        <p className="mt-3 text-xs text-muted-foreground">
          This campaign has already started sending, so its headers are frozen.
        </p>
      )}
    </div>
  );
}
