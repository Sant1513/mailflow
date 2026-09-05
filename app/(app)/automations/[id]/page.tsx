'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { ConditionBuilder, type Group } from '@/components/automation-builder/ConditionBuilder';

const FREQUENCY_MODES = [
  { value: 'ONCE', label: 'Send once per record, ever' },
  { value: 'ONCE_PER_DAY', label: 'At most once per day' },
  { value: 'ONCE_PER_WEEK', label: 'At most once per week' },
  { value: 'ONCE_PER_CAMPAIGN', label: 'Once per campaign' },
  { value: 'ALLOW_REPEATED', label: 'Allow repeated sends' },
];

export default function AutomationBuilderPage() {
  const params = useParams<{ id: string }>();
  const [automation, setAutomation] = useState<any>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [impact, setImpact] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Draft configuration
  const [triggerType, setTriggerType] = useState('RECORD_MATCHES_CONDITIONS');
  const [conditions, setConditions] = useState<Group>({ op: 'AND', rules: [] });
  const [stopConditions, setStopConditions] = useState<Group>({ op: 'OR', rules: [] });
  const [templateId, setTemplateId] = useState('');
  const [frequencyMode, setFrequencyMode] = useState('ONCE');
  const [cooldownDays, setCooldownDays] = useState(0);

  const load = useCallback(async () => {
    const res = await fetch(`/api/automations/${params.id}`);
    if (!res.ok) {
      toast.error('Failed to load automation');
      return;
    }
    const json = await res.json();
    setAutomation(json.automation);

    const version = json.automation.versions[0];
    if (version) {
      setTriggerType(version.triggerType);
      setConditions(version.conditions ?? { op: 'AND', rules: [] });
      setStopConditions(version.stopConditions ?? { op: 'OR', rules: [] });
      const sendAction = (version.actions ?? []).find((a: any) => a.type === 'SEND_EMAIL');
      setTemplateId(sendAction?.config?.templateId ?? '');
      setFrequencyMode(version.frequencyPolicy?.mode ?? 'ONCE');
      setCooldownDays(version.frequencyPolicy?.cooldownDays ?? 0);
    }

    if (json.automation.datasetId) {
      const ds = await fetch(`/api/datasets/${json.automation.datasetId}?pageSize=1`).then((r) => r.json());
      setColumns((ds.columns ?? []).map((c: any) => c.key));
    }
  }, [params.id]);

  useEffect(() => {
    load();
    fetch('/api/templates').then((r) => r.json()).then((j) => setTemplates(j.templates ?? []));
  }, [load]);

  const loadRuns = useCallback(async () => {
    const res = await fetch(`/api/automations/${params.id}/runs`);
    if (res.ok) {
      const json = await res.json();
      setRuns(json.runs ?? []);
    }
  }, [params.id]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  async function saveVersion() {
    setBusy('save');
    const res = await fetch(`/api/automations/${params.id}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        triggerType,
        triggerConfig: {},
        conditions,
        actions: templateId ? [{ type: 'SEND_EMAIL', config: { templateId } }] : [],
        stopConditions: stopConditions.rules.length > 0 ? stopConditions : null,
        frequencyPolicy: { mode: frequencyMode, cooldownDays: cooldownDays || undefined },
      }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed to save');
      return;
    }
    toast.success(json.message ?? 'Saved');
    setImpact(null);
    load();
  }

  async function checkImpact() {
    setBusy('impact');
    const res = await fetch(`/api/automations/${params.id}/enable`);
    setBusy(null);
    if (!res.ok) {
      toast.error('Could not compute impact');
      return;
    }
    setImpact(await res.json());
  }

  async function toggleEnabled(enable: boolean) {
    if (!enable) {
      setBusy('toggle');
      const res = await fetch(`/api/automations/${params.id}/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      setBusy(null);
      if (res.ok) {
        toast.success('Automation turned off');
        load();
      }
      return;
    }

    // §74: must show the impact and have it confirmed before enabling.
    const preview = impact ?? (await fetch(`/api/automations/${params.id}/enable`).then((r) => r.json()));
    setImpact(preview);
    const confirmed = confirm(
      `Automation Ready\n\n` +
        `Condition: ${preview.conditionText}\n` +
        `Potential records: ${preview.potentialRecords} of ${preview.totalRecords}\n` +
        `Action: ${preview.actions?.join(', ') || 'none'}\n\n` +
        (preview.willSendEmail
          ? `This WILL SEND EMAIL to matching records as data changes.\n\n`
          : '') +
        `Enable this automation?`
    );
    if (!confirmed) return;

    setBusy('toggle');
    const res = await fetch(`/api/automations/${params.id}/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, acknowledgedRecordCount: preview.potentialRecords }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Could not enable');
      if (json.requiresConfirmation) setImpact(json);
      return;
    }
    toast.success('Automation is ON');
    load();
  }

  if (!automation) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const version = automation.versions[0];

  return (
    <div className="p-6">
      <Link href="/automations" className="text-sm text-muted-foreground hover:text-foreground">
        ← Automations
      </Link>

      <div className="mb-6 mt-2 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{automation.name}</h1>
          <p className="text-sm text-muted-foreground">
            v{version?.version ?? 1} · {automation.enabled ? 'Running' : 'Turned off'}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={checkImpact} disabled={!!busy} className="btn-secondary">
            Check impact
          </button>
          <button onClick={saveVersion} disabled={!!busy} className="btn-secondary">
            {busy === 'save' ? 'Saving…' : 'Save new version'}
          </button>
          <button
            onClick={() => toggleEnabled(!automation.enabled)}
            disabled={!!busy}
            className={`rounded-md px-3 py-1.5 text-sm ${
              automation.enabled
                ? 'border border-warning/40 text-warning hover:bg-warning/10'
                : 'bg-primary text-primary-foreground'
            }`}
          >
            {automation.enabled ? 'Turn OFF' : 'Turn ON'}
          </button>
        </div>
      </div>

      {impact && (
        <div className="mb-6 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
          <div className="mb-1 font-semibold text-warning">Automation impact</div>
          <div className="text-warning">
            Condition: <code>{impact.conditionText}</code>
          </div>
          <div className="text-warning">
            Would act on <strong>{impact.potentialRecords}</strong> of {impact.totalRecords} records
            {impact.willSendEmail && ' — and this action SENDS EMAIL.'}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Trigger + conditions */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">Trigger</h2>
            <select
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value)}
              className="w-full rounded-md border px-2 py-1.5 text-sm"
            >
              <option value="RECORD_MATCHES_CONDITIONS">When a record matches conditions</option>
              <option value="RECORD_CREATED">When a record is created</option>
              <option value="RECORD_UPDATED">When a record is updated</option>
              <option value="MANUAL">Manual only</option>
            </select>
          </div>

          <ConditionBuilder group={conditions} columns={columns} onChange={setConditions} label="Conditions" />

          <ConditionBuilder
            group={stopConditions}
            columns={columns}
            onChange={setStopConditions}
            label="Stop conditions (skip the record if these match)"
          />
        </div>

        {/* Action + frequency */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">Action — send email</h2>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full rounded-md border px-2 py-1.5 text-sm"
            >
              <option value="">Select a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              Sends to the dataset&apos;s email column, from the dataset owner&apos;s connected Gmail account.
            </p>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">Send frequency</h2>
            <select
              value={frequencyMode}
              onChange={(e) => setFrequencyMode(e.target.value)}
              className="mb-2 w-full rounded-md border px-2 py-1.5 text-sm"
            >
              {FREQUENCY_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-xs">
              Do not send again within
              <input
                type="number"
                min={0}
                max={365}
                value={cooldownDays}
                onChange={(e) => setCooldownDays(Number(e.target.value))}
                className="w-16 rounded border px-1.5 py-1 text-xs"
              />
              days
            </label>
          </div>
        </div>
      </div>

      {/* Run log */}
      <div className="mt-6 rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Run log</h2>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No runs yet.</p>
        ) : (
          <div className="max-h-72 overflow-auto rounded border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="px-2 py-1 text-left">When</th>
                  <th className="px-2 py-1 text-left">Trigger</th>
                  <th className="px-2 py-1 text-left">Result</th>
                  <th className="px-2 py-1 text-left">Action / reason</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t">
                    <td className="px-2 py-1 text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</td>
                    <td className="px-2 py-1">{run.triggerType}</td>
                    <td className={`px-2 py-1 ${run.result === 'TRIGGERED' ? 'text-success' : run.result === 'ERROR' ? 'text-primary' : 'text-muted-foreground'}`}>
                      {run.result}
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">{run.actionTaken ?? run.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
