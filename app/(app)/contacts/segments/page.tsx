'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';

interface Segment {
  id: string;
  name: string;
  description: string | null;
  filters: SegmentFilters;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string };
}

interface SegmentFilters {
  primaryEmail?: string;
  name?: string;
  hasConversation?: boolean;
}

interface ContactRow {
  id: string;
  name: string | null;
  primaryEmail: string;
}

const EMPTY_FILTERS: SegmentFilters = {
  primaryEmail: '',
  name: '',
  hasConversation: undefined,
};

export default function SegmentsPage() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);

  // Create / edit form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formFilters, setFormFilters] = useState<SegmentFilters>(EMPTY_FILTERS);
  const [saving, setSaving] = useState(false);

  // Preview state
  const [previewing, setPreviewing] = useState(false);
  const [previewContacts, setPreviewContacts] = useState<ContactRow[] | null>(null);

  // Selected segment for contact list
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedContacts, setSelectedContacts] = useState<ContactRow[] | null>(null);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [contactCounts, setContactCounts] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/segments');
    if (!res.ok) { toast.error('Could not load segments'); setLoading(false); return; }
    const json = await res.json();
    setSegments(json.segments ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Fetch contact counts for all segments
  useEffect(() => {
    if (segments.length === 0) return;
    (async () => {
      const counts: Record<string, number> = {};
      await Promise.all(
        segments.map(async (seg) => {
          const res = await fetch(`/api/segments/${seg.id}`);
          if (res.ok) {
            const json = await res.json();
            counts[seg.id] = json.contactCount ?? 0;
          }
        })
      );
      setContactCounts(counts);
    })();
  }, [segments]);

  function openCreate() {
    setEditingId(null);
    setFormName('');
    setFormDesc('');
    setFormFilters(EMPTY_FILTERS);
    setPreviewContacts(null);
    setShowForm(true);
  }

  function openEdit(seg: Segment) {
    setEditingId(seg.id);
    setFormName(seg.name);
    setFormDesc(seg.description ?? '');
    setFormFilters({ ...EMPTY_FILTERS, ...seg.filters });
    setPreviewContacts(null);
    setShowForm(true);
    setSelectedId(null);
    setSelectedContacts(null);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setPreviewContacts(null);
  }

  async function handlePreview() {
    setPreviewing(true);
    setPreviewContacts(null);
    const res = await fetch('/api/segments/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: formFilters }),
    });
    const json = await res.json().catch(() => ({}));
    setPreviewing(false);
    if (!res.ok) { toast.error(json.error ?? 'Preview failed'); return; }
    setPreviewContacts(json.contacts ?? []);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;
    setSaving(true);
    const url = editingId ? `/api/segments/${editingId}` : '/api/segments';
    const method = editingId ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: formName.trim(), description: formDesc.trim() || undefined, filters: formFilters }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { toast.error(json.error ?? 'Save failed'); return; }
    toast.success(editingId ? 'Segment updated' : 'Segment created');
    closeForm();
    load();
  }

  async function handleDelete(seg: Segment) {
    if (!confirm(`Delete segment "${seg.name}"?`)) return;
    const res = await fetch(`/api/segments/${seg.id}`, { method: 'DELETE' });
    if (!res.ok) { toast.error('Could not delete segment'); return; }
    toast.success(`"${seg.name}" deleted`);
    if (selectedId === seg.id) { setSelectedId(null); setSelectedContacts(null); }
    load();
  }

  async function loadContacts(seg: Segment) {
    if (selectedId === seg.id) { setSelectedId(null); setSelectedContacts(null); return; }
    setSelectedId(seg.id);
    setSelectedContacts(null);
    setLoadingContacts(true);
    const res = await fetch(`/api/segments/${seg.id}/contacts`);
    const json = await res.json().catch(() => ({}));
    setLoadingContacts(false);
    if (!res.ok) { toast.error('Could not load contacts'); return; }
    setSelectedContacts(json.contacts ?? []);
  }

  const hasConvValue =
    formFilters.hasConversation === true ? 'yes' : formFilters.hasConversation === false ? 'no' : '';

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href="/contacts" className="hover:underline">Contacts</Link>
            <span>/</span>
            <span>Segments</span>
          </div>
          <h1 className="text-xl font-semibold">Contact Segments</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Saved filter combos — use them as campaign dataset sources.
          </p>
        </div>
        <button className="btn-primary shrink-0" onClick={openCreate}>
          + Create segment
        </button>
      </div>

      {/* Create / Edit form */}
      {showForm && (
        <form
          onSubmit={handleSave}
          className="mb-6 rounded-lg border bg-card p-4 space-y-4"
        >
          <h2 className="text-sm font-semibold">
            {editingId ? 'Edit segment' : 'New segment'}
          </h2>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Name <span className="text-danger">*</span>
              </label>
              <input
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Active learners"
                className="input w-full"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Description (optional)
              </label>
              <input
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                placeholder="What contacts does this target?"
                className="input w-full"
              />
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Filters
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Email contains</label>
                <input
                  value={formFilters.primaryEmail ?? ''}
                  onChange={(e) =>
                    setFormFilters((f) => ({ ...f, primaryEmail: e.target.value }))
                  }
                  placeholder="@gmail.com"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Name contains</label>
                <input
                  value={formFilters.name ?? ''}
                  onChange={(e) =>
                    setFormFilters((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="Ravi"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Has conversation</label>
                <select
                  value={hasConvValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFormFilters((f) => ({
                      ...f,
                      hasConversation:
                        v === 'yes' ? true : v === 'no' ? false : undefined,
                    }));
                  }}
                  className="input w-full"
                >
                  <option value="">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
            </div>
          </div>

          {/* Preview results */}
          {previewContacts !== null && (
            <div className="rounded-md border bg-elevated/50 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {previewContacts.length === 0
                  ? 'No contacts match these filters.'
                  : `${previewContacts.length} contact${previewContacts.length !== 1 ? 's' : ''} match`}
              </p>
              {previewContacts.length > 0 && (
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="pb-1 pr-4">Name</th>
                        <th className="pb-1">Email</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {previewContacts.map((c) => (
                        <tr key={c.id}>
                          <td className="py-1 pr-4">{c.name || '—'}</td>
                          <td className="py-1">{c.primaryEmail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={handlePreview}
              disabled={previewing}
            >
              {previewing ? 'Loading…' : previewContacts !== null
                ? `Preview (${previewContacts.length} contacts)`
                : 'Preview contacts'}
            </button>
            <button type="submit" className="btn-primary" disabled={saving || !formName.trim()}>
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create segment'}
            </button>
            <button type="button" className="btn-secondary" onClick={closeForm}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Segment list */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : segments.length === 0 ? (
        <div className="mt-16 text-center text-sm text-muted-foreground">
          No segments yet — create one above to save a filter combo.
        </div>
      ) : (
        <div className="space-y-2">
          {segments.map((seg) => (
            <div key={seg.id} className="rounded-lg border bg-card">
              <div className="flex items-start gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <button
                    className="text-sm font-medium text-primary hover:underline text-left"
                    onClick={() => loadContacts(seg)}
                  >
                    {seg.name}
                  </button>
                  {seg.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground truncate">{seg.description}</p>
                  )}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {seg.filters.primaryEmail && (
                      <span className="badge badge-neutral">email: {seg.filters.primaryEmail}</span>
                    )}
                    {seg.filters.name && (
                      <span className="badge badge-neutral">name: {seg.filters.name}</span>
                    )}
                    {seg.filters.hasConversation === true && (
                      <span className="badge badge-neutral">has conversation</span>
                    )}
                    {seg.filters.hasConversation === false && (
                      <span className="badge badge-neutral">no conversation</span>
                    )}
                    {!seg.filters.primaryEmail && !seg.filters.name && seg.filters.hasConversation === undefined && (
                      <span className="text-xs text-muted-foreground italic">no filters — matches all contacts</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-sm text-muted-foreground">
                  {contactCounts[seg.id] !== undefined && (
                    <span className="badge badge-neutral">
                      {contactCounts[seg.id]} contact{contactCounts[seg.id] !== 1 ? 's' : ''}
                    </span>
                  )}
                  <button
                    title="Edit"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => openEdit(seg)}
                  >
                    ✎
                  </button>
                  <button
                    title="Delete"
                    className="text-danger hover:opacity-80"
                    onClick={() => handleDelete(seg)}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Contact preview table */}
              {selectedId === seg.id && (
                <div className="border-t px-4 pb-3 pt-2">
                  {loadingContacts ? (
                    <p className="text-xs text-muted-foreground">Loading contacts…</p>
                  ) : selectedContacts === null ? null : selectedContacts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No contacts match this segment.</p>
                  ) : (
                    <div className="max-h-56 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-card">
                          <tr className="text-left text-muted-foreground border-b">
                            <th className="pb-1 pr-4">Name</th>
                            <th className="pb-1">Email</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {selectedContacts.map((c) => (
                            <tr key={c.id} className="hover:bg-elevated/40">
                              <td className="py-1 pr-4">
                                <Link
                                  href={`/contacts/${c.id}`}
                                  className="text-primary hover:underline"
                                >
                                  {c.name || '—'}
                                </Link>
                              </td>
                              <td className="py-1">{c.primaryEmail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedContacts.length} contact{selectedContacts.length !== 1 ? 's' : ''}
                        {selectedContacts.length === 500 ? ' (showing first 500)' : ''}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
