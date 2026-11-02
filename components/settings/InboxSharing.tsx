'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

type Level = 'VIEW' | 'REPLY';
interface Member { id: string; name: string | null; email: string }
interface Person { userId: string; name: string | null; email: string; level: Level }
interface SharedWithMe { id: string; name: string | null; email: string; level: Level }

const LEVEL_LABEL: Record<Level, string> = {
  VIEW: 'Can view',
  REPLY: 'Can view and reply',
};

/**
 * Settings → Inbox sharing. Who may see (and optionally answer) the conversations in my
 * MailFlow inbox. Off until the owner turns it on.
 */
export function InboxSharing() {
  const [loaded, setLoaded] = useState(false);
  const [everyone, setEveryone] = useState<'NONE' | Level>('NONE');
  const [people, setPeople] = useState<Person[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [sharedWithMe, setSharedWithMe] = useState<SharedWithMe[]>([]);
  const [adding, setAdding] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetch('/api/inbox-sharing')
      .then((r) => r.json())
      .then((j) => {
        setEveryone(j.everyone ?? 'NONE');
        setPeople(j.people ?? []);
        setMembers(j.members ?? []);
        setSharedWithMe(j.sharedWithMe ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const addable = useMemo(() => members.filter((m) => !people.some((p) => p.userId === m.id)), [members, people]);

  function change(fn: () => void) {
    fn();
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    const res = await fetch('/api/inbox-sharing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ everyone, people: people.map((p) => ({ userId: p.userId, level: p.level })) }),
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      setDirty(false);
      toast.success('Inbox sharing saved.');
    } else toast.error('Could not save inbox sharing.');
  }

  if (!loaded) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-muted-foreground">
        Let teammates see the student conversations in your MailFlow inbox — for example while you are on leave or
        travelling. <b>Can view</b> is read-only. <b>Can view and reply</b> also lets them answer from your mailbox, in the
        same thread, add notes and change the status. Nothing is shared until you choose it here; every reply is recorded.
      </p>

      <label className="block">
        <span className="mb-1 block font-medium">Everyone in the organisation</span>
        <select
          value={everyone}
          onChange={(e) => change(() => setEveryone(e.target.value as 'NONE' | Level))}
          className="w-full rounded border bg-background px-2 py-1.5"
        >
          <option value="NONE">Not shared</option>
          <option value="VIEW">{LEVEL_LABEL.VIEW}</option>
          <option value="REPLY">{LEVEL_LABEL.REPLY}</option>
        </select>
      </label>

      <div>
        <span className="mb-1 block font-medium">Specific people</span>
        {people.length === 0 && <p className="text-xs text-muted-foreground">No one added.</p>}
        <ul className="space-y-2">
          {people.map((p) => (
            <li key={p.userId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={p.email}>
                {p.name ?? p.email} <span className="text-xs text-muted-foreground">{p.email}</span>
              </span>
              <select
                value={p.level}
                onChange={(e) => change(() => setPeople((all) => all.map((x) => (x.userId === p.userId ? { ...x, level: e.target.value as Level } : x))))}
                className="rounded border bg-background px-2 py-1"
              >
                <option value="VIEW">{LEVEL_LABEL.VIEW}</option>
                <option value="REPLY">{LEVEL_LABEL.REPLY}</option>
              </select>
              <button
                type="button"
                onClick={() => change(() => setPeople((all) => all.filter((x) => x.userId !== p.userId)))}
                className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-elevated"
                aria-label={`Stop sharing with ${p.name ?? p.email}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        {addable.length > 0 && (
          <div className="mt-2 flex gap-2">
            <select value={adding} onChange={(e) => setAdding(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5">
              <option value="">Add a person…</option>
              {addable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ? `${m.name} (${m.email})` : m.email}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!adding}
              onClick={() => {
                const m = members.find((x) => x.id === adding);
                if (!m) return;
                change(() => setPeople((all) => [...all, { userId: m.id, name: m.name, email: m.email, level: 'VIEW' }]));
                setAdding('');
              }}
              className="rounded border px-3 py-1.5 hover:bg-elevated disabled:opacity-50"
            >
              Add
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={save}
        disabled={!dirty || saving}
        className="rounded bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save sharing'}
      </button>

      {sharedWithMe.length > 0 && (
        <div className="border-t border-border-subtle pt-3">
          <span className="mb-1 block font-medium">Shared with you</span>
          <ul className="space-y-1">
            {sharedWithMe.map((o) => (
              <li key={o.id} className="flex justify-between gap-2">
                <span className="truncate">{o.name ?? o.email}</span>
                <span className="text-xs text-muted-foreground">{LEVEL_LABEL[o.level]}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">Find these conversations in the Inbox under “Shared with me”.</p>
        </div>
      )}
    </div>
  );
}
