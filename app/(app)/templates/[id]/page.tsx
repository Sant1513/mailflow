'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { EmailPreview } from '@/components/email-preview/EmailPreview';
import { HealthCheckPanel, type HealthCheckResult } from '@/components/email-editor/HealthCheckPanel';
import { VariableMenu } from '@/components/email-editor/VariableMenu';
import { AiWriter } from '@/components/ai/AiWriter';

// CodeMirror touches `document` on load, so it must not be server-rendered.
const CodeEditor = dynamic(() => import('@/components/email-editor/CodeEditor').then((m) => m.CodeEditor), {
  ssr: false,
  loading: () => <div className="p-4 text-xs text-muted-foreground">Loading editor…</div>,
});

interface TemplateVersion {
  id: string;
  version: number;
  subject: string;
  html: string;
  css: string | null;
  plainText: string | null;
  variables: string[];
  createdAt: string;
}

interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  versions: TemplateVersion[];
}

interface DatasetOption {
  id: string;
  name: string;
}

export default function TemplateEditorPage() {
  const params = useParams<{ id: string }>();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [css, setCss] = useState('');
  const [tab, setTab] = useState<'html' | 'css'>('html');
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop');
  const [preview, setPreview] = useState<{ subject: string; html: string; missingVariables: string[]; resolved: Record<string, string>; recordLabel: string | null } | null>(null);
  const [health, setHealth] = useState<HealthCheckResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // "Preview as" data source (§25)
  const [datasets, setDatasets] = useState<DatasetOption[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [records, setRecords] = useState<{ id: string; label: string }[]>([]);
  const [recordId, setRecordId] = useState('');
  const [datasetColumns, setDatasetColumns] = useState<string[]>([]);

  const latest = template?.versions[0] ?? null;

  const dirty = useMemo(() => {
    if (!latest) return subject !== '' || html !== '' || css !== '';
    return subject !== latest.subject || html !== latest.html || (css || null) !== (latest.css || null);
  }, [latest, subject, html, css]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/templates/${params.id}`);
    if (!res.ok) {
      toast.error('Failed to load template');
      setLoading(false);
      return;
    }
    const json = await res.json();
    setTemplate(json.template);
    const v = json.template.versions[0];
    if (v) {
      setSubject(v.subject);
      setHtml(v.html);
      setCss(v.css ?? '');
    }
    setLoading(false);
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch('/api/datasets')
      .then((r) => r.json())
      .then((json) => setDatasets(json.datasets ?? []));
  }, []);

  // Load records for the chosen dataset so the user can preview as a person.
  useEffect(() => {
    if (!datasetId) {
      setRecords([]);
      setRecordId('');
      setDatasetColumns([]);
      return;
    }
    fetch(`/api/datasets/${datasetId}?pageSize=50`)
      .then((r) => r.json())
      .then((json) => {
        setDatasetColumns((json.columns ?? []).map((c: any) => c.key));
        const opts = (json.records ?? []).map((rec: any) => {
          const firstText = Object.values(rec.data ?? {}).find((v) => typeof v === 'string' && v.trim());
          return { id: rec.id, label: (firstText as string) ?? rec.id.slice(0, 8) };
        });
        setRecords(opts);
        setRecordId(opts[0]?.id ?? '');
      });
  }, [datasetId]);

  const refreshPreview = useCallback(async () => {
    const res = await fetch(`/api/templates/${params.id}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft: { subject, html, css: css || null },
        ...(recordId ? { recordId } : {}),
      }),
    });
    if (!res.ok) return;
    setPreview(await res.json());
  }, [params.id, subject, html, css, recordId]);

  // Debounced live preview as the user types.
  useEffect(() => {
    if (loading) return;
    const t = setTimeout(refreshPreview, 400);
    return () => clearTimeout(t);
  }, [refreshPreview, loading]);

  async function runHealthCheck() {
    const res = await fetch(`/api/templates/${params.id}/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft: { subject, html },
        ...(datasetId ? { datasetId } : {}),
      }),
    });
    if (!res.ok) {
      toast.error('Health check failed');
      return;
    }
    setHealth(await res.json());
  }

  async function saveVersion() {
    setSaving(true);
    const res = await fetch(`/api/templates/${params.id}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, html, css: css || null }),
    });
    setSaving(false);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed to save');
      return;
    }
    toast.success(json.created ? `Saved as v${json.version.version}` : 'No changes to save');
    load();
  }

  function insertVariable(name: string) {
    setHtml((prev) => `${prev}{{${name}}}`);
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!template) return <div className="p-6 text-sm text-muted-foreground">Template not found.</div>;

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-card px-4 py-2">
        <div className="flex items-center gap-3">
          <Link href="/templates" className="text-sm text-muted-foreground hover:text-foreground">
            ← Templates
          </Link>
          <div>
            <div className="text-sm font-semibold">{template.name}</div>
            <div className="text-xs text-muted-foreground">
              {latest ? `v${latest.version} saved ${new Date(latest.createdAt).toLocaleString()}` : 'unsaved'}
              {dirty && <span className="ml-2 text-warning">● unsaved changes</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={runHealthCheck} className="btn-secondary">
            Run health check
          </button>
          <button
            onClick={saveVersion}
            disabled={saving || !dirty}
            className="btn-primary"
          >
            {saving ? 'Saving…' : 'Save new version'}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* LEFT: settings */}
        <aside className="w-64 shrink-0 overflow-y-auto border-r bg-card p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Settings</h2>

          <label className="mb-1 block text-xs font-medium">Subject</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Reminder: RPG Clearance – {{Deadline}}"
            className="mb-3 w-full rounded-md border px-2 py-1.5 text-sm"
          />

          <label className="mb-1 block text-xs font-medium">From</label>
          <div className="mb-3 rounded-md border bg-muted px-2 py-1.5 text-xs text-muted-foreground">
            Your connected Gmail account
            <div className="mt-0.5 text-[11px]">Set up in Settings (Phase 3)</div>
          </div>

          <label className="mb-1 block text-xs font-medium">Preview as</label>
          <select
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            className="mb-2 w-full rounded-md border px-2 py-1.5 text-xs"
          >
            <option value="">— no dataset —</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          {records.length > 0 && (
            <select
              value={recordId}
              onChange={(e) => setRecordId(e.target.value)}
              className="mb-3 w-full rounded-md border px-2 py-1.5 text-xs"
            >
              {records.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          )}

          <VariableMenu columns={datasetColumns} onInsert={insertVariable} />

          <AiWriter
            subject={subject}
            html={html}
            variables={datasetColumns}
            onApply={(patch) => {
              if (patch.subject !== undefined) setSubject(patch.subject);
              if (patch.html !== undefined) setHtml(patch.html);
            }}
          />

          {preview && preview.missingVariables.length > 0 && (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
              <div className="font-medium">Unresolved variables</div>
              <div>{preview.missingVariables.map((v) => `{{${v}}}`).join(', ')}</div>
            </div>
          )}

          {preview && Object.keys(preview.resolved).length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Resolved</div>
              <dl className="space-y-1 text-[11px]">
                {Object.entries(preview.resolved).map(([k, v]) => (
                  <div key={k} className="flex gap-1">
                    <dt className="shrink-0 font-mono text-muted-foreground">{`{{${k}}}`}</dt>
                    <dd className="truncate">→ {v || <span className="italic text-warning">empty</span>}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </aside>

        {/* CENTER: code editor */}
        <div className="flex min-w-0 flex-1 flex-col border-r">
          <div className="flex items-center gap-1 border-b bg-muted px-2 py-1">
            {(['html', 'css'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded px-2 py-1 text-xs ${tab === t ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground'}`}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'html' ? (
              <CodeEditor value={html} onChange={setHtml} language="html" />
            ) : (
              <CodeEditor value={css} onChange={setCss} language="css" />
            )}
          </div>
        </div>

        {/* RIGHT: live preview */}
        <div className="flex w-[46%] min-w-0 flex-col">
          <div className="flex items-center justify-between border-b bg-muted px-2 py-1">
            <div className="truncate text-xs">
              <span className="text-muted-foreground">Subject: </span>
              <span className="font-medium">{preview?.subject || subject || '(no subject)'}</span>
              {preview?.recordLabel && (
                <span className="ml-2 rounded bg-card px-1.5 py-0.5 text-[10px]">as {preview.recordLabel}</span>
              )}
            </div>
            <div className="flex gap-1">
              {(['desktop', 'mobile'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setPreviewMode(m)}
                  className={`rounded px-2 py-1 text-xs ${previewMode === m ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground'}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <EmailPreview html={preview?.html ?? ''} mode={previewMode} />
          </div>
          {health && <HealthCheckPanel result={health} onClose={() => setHealth(null)} />}
        </div>
      </div>

      {/* Version history */}
      <div className="border-t bg-card px-4 py-2">
        <div className="flex items-center gap-3 overflow-x-auto text-xs">
          <span className="shrink-0 font-semibold uppercase text-muted-foreground">Versions</span>
          {template.versions.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                setSubject(v.subject);
                setHtml(v.html);
                setCss(v.css ?? '');
                toast.info(`Loaded v${v.version} into the editor — saving creates a new version, v${(latest?.version ?? 0) + 1}.`);
              }}
              className="shrink-0 rounded border px-2 py-1 hover:bg-elevated"
              title={new Date(v.createdAt).toLocaleString()}
            >
              v{v.version}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
