'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

const TYPE_LABEL: Record<string, { label: string; tone: string }> = {
  EMAIL_SENT: { label: 'Campaign email', tone: 'text-primary' },
  REPLY: { label: 'Reply', tone: 'text-green-700' },
  MANUAL_REPLY: { label: 'Manual reply', tone: 'text-primary' },
  AUTOMATED_MESSAGE: { label: 'Automated message', tone: 'text-amber-700' },
  NOTE: { label: 'Internal note', tone: 'text-amber-800' },
  STATUS_CHANGE: { label: 'Status change', tone: 'text-muted-foreground' },
  FOLLOW_UP: { label: 'Follow-up', tone: 'text-muted-foreground' },
};

/** §61/§111 contact profile: datasets, conversations and one chronological timeline. */
export default function ContactProfilePage() {
  const params = useParams<{ id: string }>();
  const [contact, setContact] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/contacts/${params.id}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? 'Failed to load');
        setContact(json.contact);
      })
      .catch((e) => setError(e.message));
  }, [params.id]);

  if (error) return <div className="p-6 text-sm text-red-700">{error}</div>;
  if (!contact) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const openFollowUps = contact.conversations.flatMap((c: any) => c.followUps.filter((f: any) => !f.completed));
  const unread = contact.conversations.filter((c: any) => c.unread).length;

  return (
    <div className="p-6">
      <Link href="/contacts" className="text-xs text-muted-foreground hover:text-foreground">← Contacts</Link>
      <h1 className="mt-1 text-xl font-semibold">{contact.name || contact.primaryEmail}</h1>
      <p className="text-sm text-muted-foreground">{contact.primaryEmail}{contact.phone ? ` · ${contact.phone}` : ''}</p>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <span className="rounded bg-muted px-2 py-1">{contact.records.length} dataset record{contact.records.length === 1 ? '' : 's'}</span>
        <span className="rounded bg-muted px-2 py-1">{contact.conversations.length} conversation{contact.conversations.length === 1 ? '' : 's'}</span>
        {unread > 0 && <span className="rounded bg-primary/10 px-2 py-1 text-primary">🔵 {unread} unread</span>}
        {openFollowUps.length > 0 && (
          <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">{openFollowUps.length} follow-up pending</span>
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Datasets + business data */}
        <section className="lg:col-span-1">
          <h2 className="mb-2 text-sm font-semibold">Datasets</h2>
          {contact.records.length === 0 ? (
            <p className="text-sm text-muted-foreground">No dataset records.</p>
          ) : (
            <ul className="space-y-2">
              {contact.records.map((r: any) => (
                <li key={r.id} className="rounded border bg-card p-3 text-xs">
                  <Link href={`/data/${r.dataset.id}`} className="font-medium text-primary hover:underline">{r.dataset.name}</Link>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                    {Object.entries(r.data ?? {}).slice(0, 8).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="truncate">{String(v ?? '')}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                    <span>email: {r.emailStatus ?? 'not sent'}</span>
                    {r.replyReceived && <span>· replied</span>}
                    {r.followUpRequired && <span>· follow-up</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mb-2 mt-6 text-sm font-semibold">Conversations</h2>
          {contact.conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No conversations yet.</p>
          ) : (
            <ul className="space-y-1">
              {contact.conversations.map((c: any) => (
                <li key={c.id}>
                  <Link href={`/inbox/${c.id}`} className={`block rounded border bg-card px-3 py-2 text-xs hover:bg-muted ${c.unread ? 'border-primary/40' : ''}`}>
                    <div className="flex items-center gap-1">
                      {c.unread && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                      <span className="truncate font-medium">{c.subject}</span>
                    </div>
                    <div className="text-muted-foreground">
                      {c.messages.length} msg · {c.status.replace(/_/g, ' ').toLowerCase()}
                      {c.tags?.length ? ` · ${c.tags.map((t: any) => t.tag.name).join(', ')}` : ''}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Timeline */}
        <section className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold">Timeline</h2>
          {contact.recipientHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Sent campaigns, replies, notes and follow-ups will appear here in order.
            </p>
          ) : (
            <ol className="relative ml-2 border-l">
              {contact.recipientHistory.map((h: any) => {
                const meta = TYPE_LABEL[h.type] ?? { label: h.type, tone: 'text-muted-foreground' };
                return (
                  <li key={h.id} className="mb-4 ml-4">
                    <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-card bg-muted-foreground/40" />
                    <div className="text-[11px] text-muted-foreground">{new Date(h.createdAt).toLocaleString()}</div>
                    <div className={`text-xs font-semibold ${meta.tone}`}>{meta.label}</div>
                    <div className="text-sm">{h.summary}</div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
