'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RsvpEditor } from '@/components/rsvp/RsvpEditor';
import type { RsvpConfig } from '@/lib/rsvp/config';

interface Results {
  sent: number;
  answered: number;
  notAnswered: number;
  byAnswer: Record<string, number>;
  responses: { email: string; answer: string; note: string | null; respondedAt: string; updatedAt: string; changes: number }[];
}

/** Campaign page → RSVP: the buttons' settings and who answered what. */
export function CampaignRsvp({ campaignId, canEdit }: { campaignId: string; canEdit: boolean }) {
  const [config, setConfig] = useState<RsvpConfig | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [results, setResults] = useState<Results | null>(null);
  const [columns, setColumns] = useState<{ key: string; label: string }[]>([]);
  const [lockedKeys, setLockedKeys] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${campaignId}/rsvp`, { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return;
    const j = await res.json();
    setConfig(j.config);
    setSaved(JSON.stringify(j.config));
    setResults(j.results);
    setColumns(j.columns ?? []);
    setLockedKeys(j.lockedKeys ?? []);
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(next: RsvpConfig) {
    setSaving(true);
    const res = await fetch(`/api/campaigns/${campaignId}/rsvp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => null);
    setSaving(false);
    const j = await res?.json().catch(() => ({}));
    if (res?.ok) {
      setSaved(JSON.stringify(next));
      toast.success(next.enabled ? 'RSVP buttons saved.' : 'RSVP buttons removed.');
    } else toast.error(j?.error ?? 'Could not save the RSVP settings.');
  }

  if (!config) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const dirty = JSON.stringify(config) !== saved;
  const total = results?.answered ?? 0;

  return (
    <div className="space-y-5">
      {results && (results.answered > 0 || lockedKeys.length > 0) && (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Answers</h3>
            <a href={`/api/campaigns/${campaignId}/rsvp?format=csv`} className="text-xs underline">
              Download CSV
            </a>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {config.options.map((o) => {
              const n = results.byAnswer[o.key] ?? 0;
              return (
                <div key={o.key} className="rounded-lg border p-3" style={{ borderLeft: `4px solid ${o.background}` }}>
                  <div className="text-xs text-muted-foreground">
                    {o.emoji} {o.label}
                  </div>
                  <div className="mt-1 text-xl font-semibold">
                    {n}
                    {o.capacity ? <span className="text-sm font-normal text-muted-foreground"> / {o.capacity} seats</span> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">{total ? `${Math.round((n / total) * 100)}% of answers` : '—'}</div>
                </div>
              );
            })}
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Not answered yet</div>
              <div className="mt-1 text-xl font-semibold">{results.notAnswered}</div>
              <div className="text-xs text-muted-foreground">of {results.sent} sent</div>
            </div>
          </div>
          {results.responses.length > 0 && (
            <div className="mt-3 max-h-80 overflow-auto rounded border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Email</th>
                    <th className="px-2 py-1.5 font-medium">Answer</th>
                    <th className="px-2 py-1.5 font-medium">Note</th>
                    <th className="px-2 py-1.5 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {results.responses.map((r) => {
                    const o = config.options.find((x) => x.key === r.answer);
                    return (
                      <tr key={r.email} className="border-t border-border-subtle align-top">
                        <td className="px-2 py-1.5">{r.email}</td>
                        <td className="whitespace-nowrap px-2 py-1.5">
                          {o ? `${o.emoji} ${o.label}` : r.answer}
                          {r.changes > 0 && <span className="ml-1 text-xs text-muted-foreground">(changed {r.changes}×)</span>}
                        </td>
                        <td className="px-2 py-1.5 text-xs text-muted-foreground">{r.note ?? ''}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">{new Date(r.updatedAt).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {canEdit ? (
        <>
          <RsvpEditor value={config} onChange={setConfig} columns={columns} lockedKeys={lockedKeys} />
          {(dirty || !config.enabled) && (config.enabled || saved.includes('"enabled":true')) && (
            <button type="button" disabled={saving || !dirty} onClick={() => save(config)} className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {saving ? 'Saving…' : config.enabled ? 'Save RSVP buttons' : 'Save (remove RSVP)'}
            </button>
          )}
          {lockedKeys.length > 0 && <p className="text-xs text-muted-foreground">Changes apply to emails sent from now on and to the answer pages of emails already sent.</p>}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{config.enabled ? 'RSVP buttons are on for this campaign.' : 'No RSVP buttons on this campaign.'}</p>
      )}
    </div>
  );
}
