'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { EmailPreview } from '@/components/email-preview/EmailPreview';

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_STUDENT', 'RESOLVED', 'CLOSED'];

/** §110 conversation view: header, messages + notes timeline, reply composer. */
export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [reply, setReply] = useState('');
  const [replyCc, setReplyCc] = useState('');
  const [newThread, setNewThread] = useState(false);
  const [note, setNote] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [followUpNote, setFollowUpNote] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
    load();
  }

  async function sendReply() {
    if (!reply.trim()) return;
    if (!confirm(newThread ? 'Send as a NEW email thread?' : 'Send this reply in the existing thread?')) return;
    setBusy('reply');
    const res = await fetch(`/api/conversations/${params.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: reply.split('\n').map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join(''),
        plainText: reply,
        cc: replyCc.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
        newThread,
      }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed to send');
      return;
    }
    toast.success(newThread ? 'New email sent' : 'Reply sent in the same thread');
    setReply('');
    setReplyCc('');
    setNewThread(false);
    if (json.newThread && json.conversationId !== params.id) {
      window.location.href = `/inbox/${json.conversationId}`;
      return;
    }
    load();
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

  // Merge messages and notes into one chronological timeline (§50/§58).
  const timeline = [
    ...c.messages.map((m: any) => ({ kind: 'message' as const, at: m.sentAt ?? m.receivedAt ?? m.createdAt, item: m })),
    ...c.notes.map((n: any) => ({ kind: 'note' as const, at: n.createdAt, item: n })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return (
    <div className="flex h-screen flex-col">
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
              <button onClick={() => patch({ status: 'RESOLVED' }, 'resolve')} disabled={!!busy} className="rounded border px-2 py-1 hover:bg-muted">
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

      <div className="flex min-h-0 flex-1">
        {/* Timeline */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-muted/30 p-4">
          <div className="mx-auto w-full max-w-3xl space-y-3">
            {timeline.map(({ kind, item }) =>
              kind === 'note' ? (
                <div key={`n-${item.id}`} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
                  <div className="mb-1 flex items-center justify-between text-xs text-amber-900">
                    <span><strong>INTERNAL NOTE</strong> · {item.author.name}</span>
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-amber-950">{item.body}</div>
                  <div className="mt-1 text-[10px] text-amber-800">Never sent to the recipient.</div>
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
                        <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                          {item.classification.replace(/_/g, ' ').toLowerCase()}
                        </span>
                      )}
                      {item.hasAttachments && <span className="ml-1">📎</span>}
                    </span>
                    <span>{new Date(item.sentAt ?? item.receivedAt).toLocaleString()}</span>
                  </div>
                  {expanded[item.id] ? (
                    <>
                      {item.htmlBody ? (
                        <div className="rounded border">
                          <EmailPreview html={item.htmlBody} mode="desktop" />
                        </div>
                      ) : (
                        <pre className="whitespace-pre-wrap font-sans">{item.plainTextBody}</pre>
                      )}
                      {item.attachments?.length > 0 && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          Attachments: {item.attachments.map((a: any) => `${a.filename} (${Math.round(a.size / 1024)}KB)`).join(', ')}
                        </div>
                      )}
                      <button onClick={() => setExpanded((e) => ({ ...e, [item.id]: false }))} className="mt-2 text-xs text-primary hover:underline">
                        Collapse
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="whitespace-pre-wrap">{item.plainTextBody?.trim() || item.snippet || '(no text)'}</div>
                      {item.htmlBody && (
                        <button onClick={() => setExpanded((e) => ({ ...e, [item.id]: true }))} className="mt-1 text-xs text-primary hover:underline">
                          Show formatted
                        </button>
                      )}
                    </>
                  )}
                </div>
              )
            )}
            {timeline.length === 0 && <div className="text-sm text-muted-foreground">No messages yet.</div>}
          </div>

          {/* Reply composer (§53/§54) */}
          <div className="mx-auto mt-4 w-full max-w-3xl rounded-lg border bg-card p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-semibold">
                {newThread ? 'New email' : 'Reply'}{' '}
                <span className="font-normal text-muted-foreground">
                  to {c.recipientEmail} · from {c.account.emailAddress}
                </span>
              </span>
              <label className="flex items-center gap-1 text-muted-foreground">
                <input type="checkbox" checked={newThread} onChange={(e) => setNewThread(e.target.checked)} />
                Start a new thread
              </label>
            </div>
            <input
              value={replyCc}
              onChange={(e) => setReplyCc(e.target.value)}
              placeholder="CC (optional)"
              className="mb-2 w-full rounded border px-2 py-1 text-xs"
            />
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={5}
              placeholder="Write your reply…"
              className="w-full rounded border px-2 py-1.5 text-sm"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">
                {newThread ? 'Creates a separate Gmail thread.' : 'Stays in the same Gmail thread.'}
              </span>
              <button
                onClick={sendReply}
                disabled={busy === 'reply' || !reply.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              >
                {busy === 'reply' ? 'Sending…' : newThread ? 'Send new email' : 'Send reply'}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT: notes + follow-ups */}
        <aside className="w-72 shrink-0 overflow-y-auto border-l bg-card p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Internal note</h2>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Visible to your team only…"
            className="w-full rounded border px-2 py-1 text-xs"
          />
          <button onClick={addNote} disabled={busy === 'note' || !note.trim()} className="mt-1 w-full rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">
            Add note
          </button>

          <h2 className="mb-2 mt-5 text-xs font-semibold uppercase text-muted-foreground">Follow-up</h2>
          {c.followUps.map((f: any) => (
            <label key={f.id} className={`mb-1 flex items-start gap-2 rounded border p-2 text-xs ${f.completed ? 'opacity-60' : ''}`}>
              <input type="checkbox" checked={f.completed} onChange={(e) => completeFollowUp(f.id, e.target.checked)} />
              <span>
                <div className={f.completed ? 'line-through' : new Date(f.dueDate) < new Date() ? 'font-semibold text-red-700' : 'font-semibold'}>
                  {new Date(f.dueDate).toLocaleDateString()}
                </div>
                {f.note && <div className="text-muted-foreground">{f.note}</div>}
              </span>
            </label>
          ))}
          <input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} className="mt-1 w-full rounded border px-2 py-1 text-xs" />
          <input value={followUpNote} onChange={(e) => setFollowUpNote(e.target.value)} placeholder="What to check" className="mt-1 w-full rounded border px-2 py-1 text-xs" />
          <button onClick={addFollowUp} disabled={!followUpDate} className="mt-1 w-full rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">
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
