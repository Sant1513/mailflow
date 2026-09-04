'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

export default function ContactProfilePage() {
  const params = useParams<{ id: string }>();
  const [contact, setContact] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/contacts/${params.id}`)
      .then((r) => r.json())
      .then((json) => setContact(json.contact));
  }, [params.id]);

  if (!contact) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">{contact.name || contact.primaryEmail}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{contact.primaryEmail}</p>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 text-sm font-semibold">Records</h2>
          {contact.records.length === 0 ? (
            <p className="text-sm text-muted-foreground">No dataset records yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {contact.records.map((r: any) => (
                <li key={r.id} className="rounded border bg-card px-3 py-2">
                  <span className="font-medium">{r.dataset.name}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Conversations</h2>
          {contact.conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No conversations yet — these appear once Gmail sending &amp; inbound sync (Phase
              3/5) are connected.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {contact.conversations.map((c: any) => (
                <li key={c.id} className="rounded border bg-card px-3 py-2">
                  {c.subject}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
