'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface ContactRow {
  id: string;
  name: string | null;
  primaryEmail: string;
  _count: { records: number; conversations: number };
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      const res = await fetch(`/api/contacts?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      setContacts(json.contacts ?? []);
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">Contacts</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        One person, resolved across every dataset and conversation (§18).
      </p>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name or email…"
        className="mb-4 w-full max-w-sm btn-secondary"
      />

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : contacts.length === 0 ? (
        <div className="mt-16 text-center text-sm text-muted-foreground">
          No contacts yet — they&apos;re created automatically when you import a dataset with an
          email column.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Records</th>
                <th className="px-4 py-2">Conversations</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-t hover:bg-elevated/60">
                  <td className="px-4 py-2">
                    <Link href={`/contacts/${c.id}`} className="font-medium text-primary hover:underline">
                      {c.name || '—'}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{c.primaryEmail}</td>
                  <td className="px-4 py-2">{c._count.records}</td>
                  <td className="px-4 py-2">{c._count.conversations}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
