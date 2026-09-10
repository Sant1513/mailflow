'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  updatedAt: string;
  versions: { version: number; triggerType: string; actions: any }[];
  _count: { runs: number; versions: number };
}

export default function AutomationsPage() {
  const router = useRouter();
  const [automations, setAutomations] = useState<AutomationRow[]>([]);
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [a, d] = await Promise.all([
      fetch('/api/automations').then((r) => r.json()),
      fetch('/api/datasets').then((r) => r.json()),
    ]);
    setAutomations(a.automations ?? []);
    setDatasets(d.datasets ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    const name = prompt('Automation name (e.g. "RPG Reminder")');
    if (!name) return;
    const datasetId = datasets[0]?.id ?? null;
    const res = await fetch('/api/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, datasetId }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed to create automation');
      return;
    }
    router.push(`/automations/${json.automation.id}`);
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Automations</h1>
          <p className="text-sm text-muted-foreground">
            When a record matches your conditions, run an action — automatically.
          </p>
        </div>
        <button onClick={create} className="btn-primary">
          New automation
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : automations.length === 0 ? (
        <div className="mt-16 text-center text-sm text-muted-foreground">
          No automations yet. Create one to send email automatically when data changes.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Automation</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Trigger</th>
                <th className="px-4 py-2">Actions</th>
                <th className="px-4 py-2">Runs</th>
              </tr>
            </thead>
            <tbody>
              {automations.map((a) => {
                const version = a.versions[0];
                const actions = Array.isArray(version?.actions) ? version.actions : [];
                return (
                  <tr key={a.id} className="border-t hover:bg-elevated/60">
                    <td className="px-4 py-2">
                      <Link href={`/automations/${a.id}`} className="font-medium text-primary hover:underline">
                        {a.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">v{version?.version ?? 1}</div>
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          a.enabled ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {a.enabled ? 'ON' : 'OFF'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs">{version?.triggerType.replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="px-4 py-2 text-xs">{actions.map((x: any) => x.type).join(', ') || '—'}</td>
                    <td className="px-4 py-2 text-xs">{a._count.runs}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
