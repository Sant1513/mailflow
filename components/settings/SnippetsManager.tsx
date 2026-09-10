'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Snippet {
  id: string;
  name: string;
  html: string;
}

/** §4.1 saved replies for the workspace. Variables like {{Name}} resolve at insert time in the composer. */
export function SnippetsManager() {
  const [items, setItems] = useState<Snippet[]>([]);
  const [editing, setEditing] = useState<Partial<Snippet> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/snippets');
    if (res.ok) setItems(((await res.json()).snippets ?? []).map((s: any) => ({ id: s.id, name: s.name, html: s.html })));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!editing?.name?.trim() || !editing.html?.trim()) return toast.error('Name and text are required.');
    setBusy(true);
    const res = await fetch(editing.id ? `/api/snippets/${editing.id}` : '/api/snippets', {
      method: editing.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editing.name.trim(), html: editing.html }),
    });
    setBusy(false);
    if (!res.ok) return toast.error((await res.json().catch(() => ({}))).error ?? 'Could not save');
    toast.success(editing.id ? 'Snippet updated' : 'Snippet created');
    setEditing(null);
    load();
  }

  async function remove(s: Snippet) {
    if (!confirm(`Delete snippet "${s.name}"?`)) return;
    const res = await fetch(`/api/snippets/${s.id}`, { method: 'DELETE' });
    if (!res.ok) return toast.error('Could not delete');
    load();
  }

  return (
    <div>
      {items.length === 0 && !editing && <p className="mb-2 text-xs text-muted-foreground">No saved replies yet. Create one for the messages you type most.</p>}
      <ul className="mb-2 divide-y divide-border-subtle">
        {items.map((s) => (
          <li key={s.id} className="flex items-start justify-between gap-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="font-medium">{s.name}</div>
              <div className="truncate text-xs text-faint">{s.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}</div>
            </div>
            <div className="flex shrink-0 gap-2 text-xs">
              <button onClick={() => setEditing(s)} className="text-muted-foreground hover:text-foreground">Edit</button>
              <button onClick={() => remove(s)} className="text-muted-foreground hover:text-destructive">Delete</button>
            </div>
          </li>
        ))}
      </ul>
      {editing ? (
        <div className="rounded-md border border-border-subtle bg-elevated/30 p-3">
          <input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Name, e.g. RPG completed — thanks" className="mb-2 w-full text-sm" />
          <textarea
            value={editing.html ?? ''}
            onChange={(e) => setEditing({ ...editing, html: e.target.value })}
            rows={5}
            placeholder="<p>Hi {{FirstName}},</p><p>Thanks for confirming …</p>"
            className="w-full font-mono text-xs"
          />
          <p className="mt-1 text-[11px] text-faint">HTML or plain paragraphs. Variables: {'{{Name}}'}, {'{{FirstName}}'}, {'{{Email}}'}, {'{{Sender}}'} and any dataset column.</p>
          <div className="mt-2 flex gap-2">
            <button onClick={save} disabled={busy} className="btn-primary !py-1 text-xs">{busy ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(null)} className="btn-secondary !py-1 text-xs">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setEditing({ name: '', html: '' })} className="btn-secondary !py-1 text-xs">+ New snippet</button>
      )}
    </div>
  );
}
