'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { AiSummaryCard } from '@/components/ai/ReplyAssistant';
import { MessageBody } from '@/components/inbox/MessageBody';
import { ReplyComposer, type ComposerPayload } from '@/components/inbox/ReplyComposer';

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_STUDENT', 'RESOLVED', 'CLOSED'];

/** §110 conversation view: header, messages + notes timeline, reply composer. */
export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [note, setNote] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [followUpNote, setFollowUpNote] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/conversations/${params.id}`);
    if (!res.ok) {
      toast.error('Failed to load conversation');
      return;
    }
    const json = await res.json();
    setData(json);
    // Opening it marks it read (§52).
    if (json.conversation?.unread) {
      fetch(`/api/conversations/${params.id}/read`, { method: 'POST' }).catch(() => undefined);
    }
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(label);
    const res = await fetch(`/api/conversations/${params.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? `Failed to ${label}`);
      return;
    }
    // §57/§87: say what was notified (email + Slack) so nobody wonders whether it went out.
    const n = json.notify?.assignment ?? json.notify?.resolution;
    if (n) {
      const part = (k: string, v: string) => `${k}: ${String(v).startsWith('SENT') ? 'sent' : String(v).replace(/^SKIPPED: |^FAILED: /, '')}`;
      toast.success(`${label === 'change status' ? 'Status updated' : 'Assigned'} · ${part('email', n.email)} · ${part('Slack', n.slack)}`, { duration: 8000 });
    }
    load();
  }

  async function sendReply(payload: ComposerPayload): Promise<boolean> {
    if (!confirm(payload.newThread ? 'Send as a NEW email thread?' : 'Send this reply in the existing thread?')) return false;
    setBusy('reply');
    const res = await fetch(`/api/conversations/${params.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setBusy(null);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error ?? 'Failed to send');
      return false;
    }
    toast.success(payload.newThread ? 'New email sent' : 'Reply sent in the same thread');
    if (json.newThread && json.conversationId !== params.id) {
      window.location.href = `/inbox/${json.conversationId}`;
      return true;
    }
    load();
    return true;
  }

  async function addNote() {
    if (!note.trim()) return;
    setBusy('note');
    const res = await fetch(`/api/conversations/${params.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: note }),
    });
    setBusy(null);
    if (!res.ok) {
      toast.error('Failed to add note');
      return;
    }
    setNote('');
    load();
  }

  async function addTag() {
    const name = tagInput.trim();
    if (!name) return;
    const res = await fetch(`/api/conversations/${params.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      toast.error('Failed to add tag');
      return;
    }
    setTagInput('');
    load();
  }

  async function removeTag(name: string) {
    await fetch(`/api/conversations/${params.id}/tags`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    load();
  }

  async function addFollowUp() {
    if (!followUpDate) return;
    const res = await fetch(`/api/conversations/${params.id}/follow-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dueDate: new Date(followUpDate).toISOString(), note: followUpNote || undefined }),
    });
    if (!res.ok) {
      toast.error('Failed to set follow-up');
      return;
    }
    toast.success('Follow-up set');
    setFollowUpDate('');
    setFollowUpNote('');
    load();
  }

  async function completeFollowUp(id: string, completed: boolean) {
    await fetch(`/api/conversations/${params.id}/follow-up`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ followUpId: id, completed }),
    });
    load();
  }

  if (!data) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  const c = data.conversation;

  // §80: the most recent inbound message's AI intent, if ingest or the user classified it.
  const latestInbound = [...c.messages].reverse().find((m: any) => m.direction === 'INBOUND' && m.aiIntent);
  const latestIntent = latestInbound
    ? { intent: latestInbound.aiIntent as string, confidence: latestInbound.aiIntentConfidence ?? 0, reason: latestInbound.aiIntentReason ?? '' }
    : null;

  // Merge messages and notes into one chronological timeline (§50/§58).
  const timeline = [
    ...c.messages.map((m: any) => ({ kind: 'message' as const, at: m.sentAt ?? m.receivedAt ?? m.createdAt, item: m })),
    ...c.notes.map((n: any) => ({ kind: 'note' as const, at: n.createdAt, item: n })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return (
    <div className="flex h-full min-h-[calc(100dvh-3.5rem)] lg:min-h-0 flex-col">
      {/* Header */}
      <div className="border-b bg-card px-4 py-3">
        <Link href="/inbox" className="text-xs text-muted-foreground hover:text-foreground">← Inbox</Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{c.subject}</h1>
            <div className="text-sm text-muted-foreground">
              <Link href={`/contacts/${c.contact.id}`} className="font-medium text-foreground hover:underline">
                {c.contact.name || c.recipientEmail}
              </Link>{' '}
              · {c.recipientEmail} · {c.messageCount} message{c.messageCount === 1 ? '' : 's'} · via {c.account.emailAddress}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">Status</span>
              <select
                value={c.status}
                onChange={(e) => patch({ status: e.target.value }, 'change status')}
                disabled={!!busy}
                className="rounded border px-1.5 py-1"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">Assigned</span>
              <select
                value={c.assigneeId ?? ''}
                onChange={(e) => patch({ assigneeId: e.target.value || null }, 'assign')}
                disabled={!!busy}
                className="rounded border px-1.5 py-1"
              >
                <option value="">— unassigned —</option>
                {data.members.map((m: any) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
            {c.status !== 'RESOLVED' && (
              <button onClick={() => patch({ status: 'RESOLVED' }, 'resolve')} disabled={!!busy} className="rounded border px-2 py-1 hover:bg-elevated">
                Mark resolved
              </button>
            )}
          </div>
        </div>

        {/* Tags */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {c.tags.map((t: any) => (
            <span key={t.tag.id} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]">
              {t.tag.name}
              <button onClick={() => removeTag(t.tag.name)} className="text-muted-foreground hover:text-destructive" title="Remove tag">✕</button>
            </span>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTag()}
            placeholder="+ tag"
            className="w-24 rounded border px-1.5 py-0.5 text-[11px]"
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Timeline */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-muted/30 p-4">
          <div className="mx-auto w-full max-w-3xl space-y-3">
            {timeline.map(({ kind, item }) =>
              kind === 'note' ? (
                <div key={`n-${item.id}`} className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                  <div className="mb-1 flex items-center justify-between text-xs text-warning">
                    <span><strong>INTERNAL NOTE</strong> · {item.author.name}</span>
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-warning">{item.body}</div>
                  <div className="mt-1 text-[10px] text-warning">Never sent to the recipient.</div>
                </div>
              ) : (
                <div
                  key={`m-${item.id}`}
                  className={`rounded-lg border bg-card p-3 text-sm ${item.direction === 'OUTBOUND' ? 'ml-8' : 'mr-8'}`}
                >
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      <strong className={item.direction === 'OUTBOUND' ? 'text-primary' : ''}>
                        {item.direction === 'OUTBOUND' ? 'You' : item.senderName || item.senderEmail}
                      </strong>{' '}
                      · {item.direction}
                      {item.classification && item.classification !== 'HUMAN_REPLY' && item.direction === 'INBOUND' && (
                        <span className="ml-1 rounded bg-warning/15 px-1 text-[10px] text-warning">
                          {item.classification.replace(/_/g, ' ').toLowerCase()}
                        </span>
                      )}
                      {item.hasAttachments && <span className="ml-1">📎</span>}
                    </span>
                    <span>{new Date(item.sentAt ?? item.receivedAt).toLocaleString()}</span>
                  </div>
                  <MessageBody main={item.bodyMain ?? '<p><em>(no text)</em></p>'} quoted={item.bodyQuoted ?? null} />
                  {item.attachments?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                      {item.attachments.map((a: any) => (
                        <span key={a.id} className="badge badge-neutral !normal-case !tracking-normal" title={a.mimeType}>
                          📎 {a.filename} <span className="text-faint">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            )}
            {timeline.length === 0 && <div className="text-sm text-muted-foreground">No messages yet.</div>}
          </div>

          {/* Reply composer (§53/§54): rich text / HTML / preview, attachments, snippets */}
          <ReplyComposer
            conversationId={c.id}
            recipientEmail={c.recipientEmail}
            fromEmail={c.account.emailAddress}
            fromName={c.account.displayName ?? ''}
            subject={c.subject}
            busy={busy === 'reply'}
            onSend={sendReply}
          />
        </div>

        {/* RIGHT: notes + follow-ups */}
        <aside className="w-full shrink-0 overflow-y-auto border-t bg-card p-3 lg:w-72 lg:border-l lg:border-t-0">
          <AiSummaryCard
            conversationId={c.id}
            currentStatus={c.status}
            onApplyStatus={(status) => patch({ status }, 'change status')}
            latestIntent={latestIntent}
          />

          <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Internal note</h2>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Visible to your team only…"
            className="w-full rounded border px-2 py-1 text-xs"
          />
          <button onClick={addNote} disabled={busy === 'note' || !note.trim()} className="mt-1 w-full rounded border px-2 py-1 text-xs hover:bg-elevated disabled:opacity-50">
            Add note
          </button>

          <h2 className="mb-2 mt-5 text-xs font-semibold uppercase text-muted-foreground">Follow-up</h2>
          {c.followUps.map((f: any) => (
            <label key={f.id} className={`mb-1 flex items-start gap-2 rounded border p-2 text-xs ${f.completed ? 'opacity-60' : ''}`}>
              <input type="checkbox" checked={f.completed} onChange={(e) => completeFollowUp(f.id, e.target.checked)} />
              <span>
                <div className={f.completed ? 'line-through' : new Date(f.dueDate) < new Date() ? 'font-semibold text-primary' : 'font-semibold'}>
                  {new Date(f.dueDate).toLocaleDateString()}
                </div>
                {f.note && <div className="text-muted-foreground">{f.note}</div>}
              </span>
            </label>
          ))}
          <input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} className="mt-1 w-full rounded border px-2 py-1 text-xs" />
          <input value={followUpNote} onChange={(e) => setFollowUpNote(e.target.value)} placeholder="What to check" className="mt-1 w-full rounded border px-2 py-1 text-xs" />
          <button onClick={addFollowUp} disabled={!followUpDate} className="mt-1 w-full rounded border px-2 py-1 text-xs hover:bg-elevated disabled:opacity-50">
            Set follow-up
          </button>

          <h2 className="mb-2 mt-5 text-xs font-semibold uppercase text-muted-foreground">Thread</h2>
          <dl className="space-y-1 text-[11px] text-muted-foreground">
            <div><dt className="inline">Gmail thread: </dt><dd className="inline break-all font-mono">{c.gmailThreadId ?? '—'}</dd></div>
            <div><dt className="inline">Mailbox: </dt><dd className="inline">{c.account.emailAddress}</dd></div>
            <div><dt className="inline">First message: </dt><dd className="inline">{c.firstMessageAt ? new Date(c.firstMessageAt).toLocaleString() : '—'}</dd></div>
          </dl>
        </aside>
      </div>
    </div>
  );
}
