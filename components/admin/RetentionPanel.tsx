'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, type RetentionPolicyInput } from '@/lib/retention/policy';

interface Preview {
  messageBodies: number;
  emailJobBodies: number;
  auditLogs: number;
}

interface Loaded {
  policy: RetentionPolicyInput & { updatedAt: string | null; updatedBy: string | null };
  preview: Preview;
}

const FIELDS: { key: keyof RetentionPolicyInput; label: string; hint: string; previewKey: keyof Preview; previewLabel: string }[] = [
  {
    key: 'messageBodyDays',
    label: 'Conversation message bodies',
    hint: 'Strip stored HTML/plain-text bodies of inbound and outbound messages older than this. Headers, subjects and threading stay.',
    previewKey: 'messageBodies',
    previewLabel: 'messages',
  },
  {
    key: 'emailJobBodyDays',
    label: 'Sent email snapshots',
    hint: 'Strip the rendered html/plain-text of sent emails older than this. Status, recipient, subject and Gmail IDs stay (§126).',
    previewKey: 'emailJobBodies',
    previewLabel: 'sent emails',
  },
  {
    key: 'auditLogDays',
    label: 'Audit log rows',
    hint: 'Delete audit-log entries older than this.',
    previewKey: 'auditLogs',
    previewLabel: 'audit rows',
  },
];

/** §130 — configure retention, see exactly what it would touch. Saving never deletes anything. */
export function RetentionPanel({ readOnly }: { readOnly: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Record<keyof RetentionPolicyInput, string>>({
    messageBodyDays: '',
    emailJobBodyDays: '',
    auditLogDays: '',
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  function toInput(): RetentionPolicyInput | { error: string } {
    const out: Partial<RetentionPolicyInput> = {};
    for (const f of FIELDS) {
      const raw = draft[f.key].trim();
      if (raw === '') {
        out[f.key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) {
        return { error: `${f.label}: enter a whole number between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}, or leave blank to keep forever.` };
      }
      out[f.key] = n;
    }
    return out as RetentionPolicyInput;
  }

  async function load() {
    const res = await fetch('/api/admin/retention');
    if (!res.ok) {
      toast.error('Could not load the retention policy');
      return;
    }
    const json: Loaded = await res.json();
    setLoaded(json);
    setPreview(json.preview);
    setDraft({
      messageBodyDays: json.policy.messageBodyDays?.toString() ?? '',
      emailJobBodyDays: json.policy.emailJobBodyDays?.toString() ?? '',
      auditLogDays: json.policy.auditLogDays?.toString() ?? '',
    });
  }

  useEffect(() => {
    load();
  }, []);

  async function previewDraft() {
    const input = toInput();
    if ('error' in input) {
      toast.error(input.error);
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/admin/retention?preview=${encodeURIComponent(JSON.stringify(input))}`);
    setBusy(false);
    if (!res.ok) {
      toast.error('Preview failed');
      return;
    }
    const json: Loaded = await res.json();
    setPreview(json.preview);
    toast.success('Preview updated — nothing was changed');
  }

  async function save() {
    const input = toInput();
    if ('error' in input) {
      toast.error(input.error);
      return;
    }
    setBusy(true);
    const res = await fetch('/api/admin/retention', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      toast.error(json.error ?? 'Could not save the policy');
      return;
    }
    const json: Loaded = await res.json();
    setLoaded(json);
    setPreview(json.preview);
    toast.success('Retention policy saved and audited');
  }

  if (!loaded) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
        <div className="font-heading font-semibold text-warning">Configuration only — nothing is deleted automatically.</div>
        <p className="mt-1 text-muted-foreground">
          Saving records the policy and who set it. Enforcement is a separate, explicit, audited action that is not
          enabled in this release (§130: never delete historical communication accidentally).
        </p>
      </div>

      <div className="grid gap-4">
        {FIELDS.map((f) => (
          <div key={f.key} className="grid gap-3 rounded-md border border-border-subtle bg-elevated/30 p-4 sm:grid-cols-[1fr_auto]">
            <div>
              <label htmlFor={f.key} className="font-heading text-sm font-semibold">
                {f.label}
              </label>
              <p className="mt-1 text-xs text-muted-foreground">{f.hint}</p>
              {preview && (
                <p className="mt-2 text-xs">
                  <span className="text-faint">Would affect now: </span>
                  <span className={`font-semibold tabular-nums ${preview[f.previewKey] > 0 ? 'text-warning' : 'text-success'}`}>
                    {preview[f.previewKey].toLocaleString('en-IN')}
                  </span>
                  <span className="text-faint"> {f.previewLabel}</span>
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                id={f.key}
                type="number"
                inputMode="numeric"
                min={MIN_RETENTION_DAYS}
                max={MAX_RETENTION_DAYS}
                placeholder="forever"
                disabled={readOnly}
                value={draft[f.key]}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                className="w-28 text-sm"
              />
              <span className="text-xs text-muted-foreground">days</span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={previewDraft} disabled={busy} className="btn-secondary">
          Preview impact
        </button>
        <button onClick={save} disabled={busy || readOnly} className="btn-primary">
          Save policy
        </button>
        <span className="text-xs text-faint">
          {loaded.policy.updatedAt
            ? `Last set ${new Date(loaded.policy.updatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}${loaded.policy.updatedBy ? ` by ${loaded.policy.updatedBy}` : ''}`
            : 'No policy set — everything is kept forever.'}
        </span>
      </div>
    </div>
  );
}
