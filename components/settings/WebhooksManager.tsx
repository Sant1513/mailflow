'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

const ALL_EVENTS = [
  { value: 'conversation.created', label: 'Conversation created' },
  { value: 'conversation.resolved', label: 'Conversation resolved' },
  { value: 'conversation.message.received', label: 'Message received' },
  { value: 'email.bounced', label: 'Email bounced' },
  { value: 'email.unsubscribed', label: 'Email unsubscribed' },
];

interface Endpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Delivery {
  id: string;
  event: string;
  status: string;
  statusCode: number | null;
  responseBody: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  createdAt: string;
}

export function WebhooksManager() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formUrl, setFormUrl] = useState('');
  const [formEvents, setFormEvents] = useState<string[]>([]);
  const [formDesc, setFormDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  // Drawer for deliveries
  const [drawerEndpoint, setDrawerEndpoint] = useState<Endpoint | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editEvents, setEditEvents] = useState<string[]>([]);
  const [editDesc, setEditDesc] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/webhooks');
    if (res.ok) setEndpoints((await res.json()).endpoints ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleFormEvent(ev: string) {
    setFormEvents((prev) => prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]);
  }

  function toggleEditEvent(ev: string) {
    setEditEvents((prev) => prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]);
  }

  async function create() {
    if (!formUrl.trim()) return toast.error('URL is required');
    if (!formUrl.startsWith('https://')) return toast.error('URL must start with https://');
    if (formEvents.length === 0) return toast.error('Select at least one event');
    setSaving(true);
    const res = await fetch('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: formUrl.trim(), events: formEvents, description: formDesc.trim() || undefined }),
    });
    setSaving(false);
    if (!res.ok) return toast.error((await res.json().catch(() => ({}))).error ?? 'Failed to create endpoint');
    const data = await res.json();
    toast.success('Webhook endpoint created');
    setNewSecret(data.endpoint.secret);
    setShowForm(false);
    setFormUrl('');
    setFormEvents([]);
    setFormDesc('');
    load();
  }

  async function toggleActive(ep: Endpoint) {
    const res = await fetch(`/api/webhooks/${ep.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !ep.active }),
    });
    if (!res.ok) return toast.error('Could not update');
    toast.success(ep.active ? 'Endpoint disabled' : 'Endpoint enabled');
    load();
  }

  async function deleteEndpoint(ep: Endpoint) {
    if (!confirm(`Delete webhook for ${ep.url}?`)) return;
    const res = await fetch(`/api/webhooks/${ep.id}`, { method: 'DELETE' });
    if (!res.ok) return toast.error('Could not delete');
    toast.success('Endpoint deleted');
    load();
  }

  async function sendTest(ep: Endpoint) {
    const res = await fetch(`/api/webhooks/${ep.id}/test`, { method: 'POST' });
    if (!res.ok) return toast.error('Test request failed');
    const { delivery } = await res.json();
    if (delivery.status === 'SUCCESS') {
      toast.success(`Test delivered — HTTP ${delivery.statusCode}`);
    } else {
      toast.error(`Test failed${delivery.statusCode ? ` — HTTP ${delivery.statusCode}` : ' (no response)'}`);
    }
  }

  async function openDeliveries(ep: Endpoint) {
    setDrawerEndpoint(ep);
    setDrawerLoading(true);
    const res = await fetch(`/api/webhooks/${ep.id}`);
    setDrawerLoading(false);
    if (res.ok) setDeliveries((await res.json()).deliveries ?? []);
  }

  function startEdit(ep: Endpoint) {
    setEditingId(ep.id);
    setEditUrl(ep.url);
    setEditEvents([...ep.events]);
    setEditDesc(ep.description ?? '');
  }

  async function saveEdit(ep: Endpoint) {
    if (!editUrl.trim()) return toast.error('URL is required');
    if (!editUrl.startsWith('https://')) return toast.error('URL must start with https://');
    if (editEvents.length === 0) return toast.error('Select at least one event');
    setEditSaving(true);
    const res = await fetch(`/api/webhooks/${ep.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: editUrl.trim(), events: editEvents, description: editDesc.trim() || null }),
    });
    setEditSaving(false);
    if (!res.ok) return toast.error((await res.json().catch(() => ({}))).error ?? 'Could not save');
    toast.success('Endpoint updated');
    setEditingId(null);
    load();
  }

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div>
      {/* New secret banner */}
      {newSecret && (
        <div className="mb-4 rounded border border-yellow-400 bg-yellow-50 p-3 text-sm dark:bg-yellow-950 dark:border-yellow-600">
          <p className="font-semibold text-yellow-800 dark:text-yellow-200">Signing secret — copy it now, it will not be shown again</p>
          <code className="mt-1 block break-all rounded bg-yellow-100 px-2 py-1 font-mono text-xs dark:bg-yellow-900">{newSecret}</code>
          <button
            onClick={() => { navigator.clipboard.writeText(newSecret); toast.success('Copied'); }}
            className="mt-2 rounded bg-yellow-400 px-2 py-1 text-xs font-medium hover:bg-yellow-500 dark:bg-yellow-700 dark:hover:bg-yellow-600"
          >
            Copy
          </button>
          <button
            onClick={() => setNewSecret(null)}
            className="ml-2 text-xs text-yellow-700 underline dark:text-yellow-300"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Deliveries drawer */}
      {drawerEndpoint && (
        <div className="fixed inset-0 z-50 flex" onClick={() => setDrawerEndpoint(null)}>
          <div className="flex-1 bg-black/40" />
          <div
            className="w-full max-w-lg overflow-y-auto bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b p-4">
              <div>
                <p className="text-sm font-semibold">Recent deliveries</p>
                <p className="truncate text-xs text-muted-foreground">{drawerEndpoint.url}</p>
              </div>
              <button onClick={() => setDrawerEndpoint(null)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>
            {drawerLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            ) : deliveries.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No deliveries yet.</div>
            ) : (
              <ul className="divide-y">
                {deliveries.map((d) => (
                  <li key={d.id} className="p-3 text-xs">
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 font-medium ${d.status === 'SUCCESS' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : d.status === 'FAILED' ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' : 'bg-muted text-muted-foreground'}`}>
                        {d.status}
                      </span>
                      <span className="font-mono">{d.event}</span>
                      {d.statusCode && <span className="text-muted-foreground">HTTP {d.statusCode}</span>}
                      <span className="ml-auto text-muted-foreground">{new Date(d.createdAt).toLocaleString()}</span>
                    </div>
                    {d.responseBody && (
                      <pre className="mt-1 max-h-24 overflow-auto rounded bg-muted px-2 py-1 font-mono text-[10px]">{d.responseBody}</pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Endpoint list */}
      {endpoints.length === 0 && !showForm && (
        <p className="mb-3 text-sm text-muted-foreground">No webhook endpoints registered yet.</p>
      )}

      <ul className="mb-4 space-y-3">
        {endpoints.map((ep) => (
          <li key={ep.id} className="rounded border bg-background p-3 text-sm">
            {editingId === ep.id ? (
              <div className="space-y-2">
                <input
                  className="w-full rounded border px-2 py-1 text-sm font-mono bg-background"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  placeholder="https://your-server.example.com/webhook"
                />
                <div className="flex flex-wrap gap-3">
                  {ALL_EVENTS.map((ev) => (
                    <label key={ev.value} className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={editEvents.includes(ev.value)}
                        onChange={() => toggleEditEvent(ev.value)}
                      />
                      {ev.label}
                    </label>
                  ))}
                </div>
                <input
                  className="w-full rounded border px-2 py-1 text-sm bg-background"
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="Description (optional)"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => saveEdit(ep)}
                    disabled={editSaving}
                    className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {editSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => setEditingId(null)} className="text-xs text-muted-foreground underline">Cancel</button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs">{ep.url}</p>
                    {ep.description && <p className="text-xs text-muted-foreground">{ep.description}</p>}
                    <p className="mt-1 flex flex-wrap gap-1">
                      {ep.events.map((ev) => (
                        <span key={ev} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">{ev}</span>
                      ))}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${ep.active ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-muted text-muted-foreground'}`}>
                      {ep.active ? 'Active' : 'Disabled'}
                    </span>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <button onClick={() => startEdit(ep)} className="text-muted-foreground underline hover:text-foreground">Edit</button>
                  <button onClick={() => toggleActive(ep)} className="text-muted-foreground underline hover:text-foreground">
                    {ep.active ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => sendTest(ep)} className="text-muted-foreground underline hover:text-foreground">Send test</button>
                  <button onClick={() => openDeliveries(ep)} className="text-muted-foreground underline hover:text-foreground">View deliveries</button>
                  <button onClick={() => deleteEndpoint(ep)} className="text-red-500 underline hover:text-red-700">Delete</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Add endpoint form */}
      {showForm ? (
        <div className="space-y-3 rounded border bg-background p-3">
          <p className="text-sm font-medium">New webhook endpoint</p>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">URL (must be https://)</label>
            <input
              className="w-full rounded border px-2 py-1 text-sm font-mono bg-background"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder="https://your-server.example.com/webhook"
              autoFocus
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Events to receive</p>
            <div className="flex flex-wrap gap-3">
              {ALL_EVENTS.map((ev) => (
                <label key={ev.value} className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={formEvents.includes(ev.value)}
                    onChange={() => toggleFormEvent(ev.value)}
                  />
                  {ev.label}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Description (optional)</label>
            <input
              className="w-full rounded border px-2 py-1 text-sm bg-background"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              placeholder="e.g. Production CRM sync"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={create}
              disabled={saving}
              className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create endpoint'}
            </button>
            <button onClick={() => { setShowForm(false); setFormUrl(''); setFormEvents([]); setFormDesc(''); }} className="text-xs text-muted-foreground underline">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90"
        >
          Add endpoint
        </button>
      )}
    </div>
  );
}
