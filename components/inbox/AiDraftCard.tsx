'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Draft {
  id: string;
  html: string;
  plainText: string;
  createdAt: string;
}

/**
 * AI triage leaves a draft answer on questions and requests. One click sends
 * it in the thread; Edit moves it into the composer; Discard drops it.
 */
export function AiDraftCard({
  conversationId,
  refreshKey,
  canWrite,
  onSent,
  onEdit,
}: {
  conversationId: string;
  /** Changes whenever the conversation reloads, so a newer draft shows up. */
  refreshKey: unknown;
  canWrite: boolean;
  onSent: () => void;
  onEdit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<'send' | 'discard' | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/conversations/${conversationId}/ai-draft`);
    if (!res.ok) return;
    const json = (await res.json()) as { draft: Draft | null };
    setDraft(json.draft);
  }, [conversationId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function mark(status: 'SENT' | 'CANCELLED', edited = false) {
    if (!draft) return;
    await fetch(`/api/conversations/${conversationId}/ai-draft`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: draft.id, status, edited }),
    }).catch(() => undefined);
  }

  async function approve() {
    if (!draft) return;
    setBusy('send');
    const res = await fetch(`/api/conversations/${conversationId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: draft.html, plainText: draft.plainText, cc: [], newThread: false, attachments: [] }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBusy(null);
      toast.error(json.error ?? 'Failed to send the draft');
      return;
    }
    await mark('SENT');
    setBusy(null);
    setDraft(null);
    toast.success('AI draft sent in the same thread');
    onSent();
  }

  async function discard() {
    setBusy('discard');
    await mark('CANCELLED');
    setBusy(null);
    setDraft(null);
  }

  async function edit() {
    if (!draft) return;
    onEdit(draft.plainText);
    await mark('CANCELLED', true);
    setDraft(null);
  }

  if (!draft) return null;

  return (
    <div className="mb-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">AI draft ready</span>
        <span className="text-[10px] text-muted-foreground">
          {new Date(draft.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
        </span>
      </div>
      <p className="mb-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-foreground">{draft.plainText}</p>
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          <button onClick={approve} disabled={!!busy} className="btn-primary !px-3 !py-1 text-xs">
            {busy === 'send' ? 'Sending…' : 'Approve & send'}
          </button>
          <button onClick={edit} disabled={!!busy} className="btn-secondary !px-3 !py-1 text-xs">
            Edit
          </button>
          <button onClick={discard} disabled={!!busy} className="text-xs text-muted-foreground hover:text-foreground">
            Discard
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">Read-only: you can&apos;t send from this view.</p>
      )}
      <p className="mt-2 text-[10px] text-muted-foreground">Check facts before sending. The AI only knows what is in this thread.</p>
    </div>
  );
}
