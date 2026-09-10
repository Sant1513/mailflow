'use client';

import { useState } from 'react';
import { toast } from 'sonner';

type ColumnType =
  | 'TEXT' | 'LONG_TEXT' | 'EMAIL' | 'NUMBER' | 'DATE' | 'DATETIME'
  | 'CHECKBOX' | 'SINGLE_SELECT' | 'MULTI_SELECT' | 'URL' | 'STATUS' | 'FORMULA';

interface PreviewResult {
  headers: string[];
  rowCount: number;
  rows: Record<string, string>[];
  sampleRows: Record<string, string>[];
  inferredTypes: Record<string, ColumnType>;
  suggestedEmailColumn: string | null;
  duplicates: { uniqueEmails: number; duplicateRows: number } | null;
}

function toKey(header: string): string {
  const cleaned = header
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-zA-Z]/.test(cleaned) ? cleaned : `f_${cleaned}`;
}

export function ImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<'paste' | 'review'>('paste');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [types, setTypes] = useState<Record<string, ColumnType>>({});
  const [emailColumn, setEmailColumn] = useState<string>('');
  const [datasetName, setDatasetName] = useState('');
  const [dupStrategy, setDupStrategy] = useState<'KEEP_FIRST' | 'KEEP_LATEST' | 'IMPORT_ALL'>('KEEP_FIRST');
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function runPreview() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/datasets/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'paste', text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to parse data');
      setPreview(json);
      setTypes(json.inferredTypes);
      setEmailColumn(json.suggestedEmailColumn ?? '');
      setStep('review');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview || !datasetName.trim()) {
      toast.error('Give the dataset a name');
      return;
    }
    setBusy(true);
    try {
      const headerToKey: Record<string, string> = {};
      const columns = preview.headers.map((h) => {
        const key = toKey(h);
        headerToKey[h] = key;
        return { key, label: h, type: types[h] ?? 'TEXT' };
      });

      const res = await fetch('/api/datasets/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          datasetName,
          columns,
          headerToKey,
          rows: preview.rows,
          emailColumn: emailColumn || undefined,
          duplicateStrategy: dupStrategy,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Import failed');
      toast.success(`Imported ${json.recordsImported} records`);
      reset();
      onImported();
      onClose();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep('paste');
    setText('');
    setPreview(null);
    setDatasetName('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-card p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Import data</h2>
          <button onClick={() => { reset(); onClose(); }} className="text-sm text-muted-foreground hover:text-foreground">
            Close
          </button>
        </div>

        {step === 'paste' && (
          <div>
            <p className="mb-2 text-sm text-muted-foreground">
              Paste data copied from Google Sheets or Excel (first row = headers). Import never
              sends any email — it only creates records.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              placeholder={'Name\tEmail\tCode\tDeadline\nRahul Sharma\trahul@example.com\tfd41_470074\t16 April 2025'}
              className="w-full rounded-md border p-2 font-mono text-xs"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={onClose} className="btn-secondary">
                Cancel
              </button>
              <button
                disabled={busy}
                onClick={runPreview}
                className="btn-primary"
              >
                {busy ? 'Parsing…' : 'Preview'}
              </button>
            </div>
          </div>
        )}

        {step === 'review' && preview && (
          <div>
            <div className="mb-4 grid grid-cols-3 gap-3 rounded-md bg-muted p-3 text-sm">
              <div>
                <div className="font-semibold">{preview.rowCount}</div>
                <div className="text-xs text-muted-foreground">records</div>
              </div>
              <div>
                <div className="font-semibold">{preview.headers.length}</div>
                <div className="text-xs text-muted-foreground">columns</div>
              </div>
              <div>
                <div className="font-semibold">
                  {preview.duplicates ? `${preview.duplicates.duplicateRows} duplicates` : '—'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {preview.duplicates ? `${preview.duplicates.uniqueEmails} unique emails` : 'no email column detected'}
                </div>
              </div>
            </div>

            <label className="mb-1 block text-xs font-medium">Dataset name</label>
            <input
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
              placeholder="Placement Students September 2026"
              className="mb-4 w-full rounded-md border px-2 py-1.5 text-sm"
            />

            <div className="mb-4 overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted">
                  <tr>
                    {preview.headers.map((h) => (
                      <th key={h} className="whitespace-nowrap px-2 py-1 text-left">
                        <div>{h}</div>
                        <select
                          value={types[h]}
                          onChange={(e) => setTypes((t) => ({ ...t, [h]: e.target.value as ColumnType }))}
                          className="mt-1 w-full rounded border bg-card px-1 py-0.5 text-[11px]"
                        >
                          {['TEXT', 'LONG_TEXT', 'EMAIL', 'NUMBER', 'DATE', 'DATETIME', 'CHECKBOX', 'URL', 'STATUS'].map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sampleRows.slice(0, 8).map((row, i) => (
                    <tr key={i} className="border-t">
                      {preview.headers.map((h) => (
                        <td key={h} className="whitespace-nowrap px-2 py-1">{row[h]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
              <div>
                <label className="mr-2 text-xs font-medium">Email column</label>
                <select
                  value={emailColumn}
                  onChange={(e) => setEmailColumn(e.target.value)}
                  className="rounded border px-2 py-1 text-sm"
                >
                  <option value="">— none —</option>
                  {preview.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </div>
              {preview.duplicates && preview.duplicates.duplicateRows > 0 && (
                <div>
                  <label className="mr-2 text-xs font-medium">Duplicates</label>
                  <select
                    value={dupStrategy}
                    onChange={(e) => setDupStrategy(e.target.value as any)}
                    className="rounded border px-2 py-1 text-sm"
                  >
                    <option value="KEEP_FIRST">Keep first</option>
                    <option value="KEEP_LATEST">Keep latest</option>
                    <option value="IMPORT_ALL">Import all</option>
                  </select>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setStep('paste')} className="btn-secondary">
                Back
              </button>
              <button
                disabled={busy}
                onClick={commit}
                className="btn-primary"
              >
                {busy ? 'Importing…' : `Import ${preview.rowCount} records`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
