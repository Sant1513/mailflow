'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { COOL_OFF_NOTE_MAX, coolOffInputValue } from '@/lib/contacts/recentEmailed';

/** "Do not contact until" date + optional note for one contact; Save / Clear. */
export function CoolOffEditor({
  contactId,
  until,
  note,
  onSaved,
}: {
  contactId: string;
  until: string | null;
  note: string | null;
  onSaved: (v: { doNotContactUntil: string | null; coolOffNote: string | null }) => void;
}) {
  const [date, setDate] = useState(coolOffInputValue(until));
  const [text, setText] = useState(note ?? '');
  const [busy, setBusy] = useState(false);

  async function send(body: { doNotContactUntil: string | null; coolOffNote?: string | null }, done: string) {
    setBusy(true);
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    const json = await res?.json().catch(() => ({}));
    setBusy(false);
    if (!res?.ok) return toast.error(json?.issues?.[0]?.message ?? json?.error ?? 'Could not save.');
    toast.success(done);
    onSaved({ doNotContactUntil: json.contact.doNotContactUntil, coolOffNote: json.contact.coolOffNote });
    if (body.doNotContactUntil === null) {
      setDate('');
      setText('');
    }
  }

  return (
    <div className="mt-4 max-w-xl rounded-lg border bg-card p-3 text-xs">
      <div className="mb-2 text-sm font-semibold">Do not contact until</div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="!w-auto !py-1.5 text-xs" aria-label="Do not contact until" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, COOL_OFF_NOTE_MAX))}
          maxLength={COOL_OFF_NOTE_MAX}
          placeholder="Note (optional)"
          className="min-w-[12rem] flex-1 !py-1.5 text-xs"
          aria-label="Cool-off note"
        />
        <button type="button" disabled={busy || !date} onClick={() => send({ doNotContactUntil: date, coolOffNote: text.trim() || null }, 'Saved.')} className="btn-primary !py-1.5 text-[11px] disabled:opacity-50">
          Save
        </button>
        <button type="button" disabled={busy || (!until && !date && !text)} onClick={() => send({ doNotContactUntil: null }, 'Cleared.')} className="btn-secondary !py-1.5 text-[11px] disabled:opacity-50">
          Clear
        </button>
      </div>
      <p className="mt-2 text-muted-foreground">Bulk sends skip this person until the date, and say why.</p>
    </div>
  );
}
