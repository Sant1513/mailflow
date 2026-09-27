'use client';

import type { BulkSignerConfig } from '@/lib/signing/fields';
import type { DataMapping, SigningSource } from '@/lib/signing/fromData';

interface Props {
  source: SigningSource & { truncated?: boolean };
  mapping: DataMapping;
  onChange: (next: DataMapping) => void;
  fieldDefs: { key: string; label: string }[];
  extraSigners: BulkSignerConfig[];
  readyCount: number;
  onClear: () => void;
}

/**
 * "Send for signature" from Data: shows which column feeds the signer and
 * each document field (matched automatically by name) and lets the sender
 * change any of them. Changing a column rebuilds the recipient table below.
 */
export function DataMappingPanel({ source, mapping, onChange, fieldDefs, extraSigners, readyCount, onClear }: Props) {
  const total = source.rows.length;
  const linked = source.rows.filter((r) => r.recordId).length;
  const skipped = total - readyCount;

  const select = (value: string, set: (v: string) => void, label: string, emptyText = '— not mapped —') => (
    <select value={value} onChange={(e) => set(e.target.value)} className="w-full !py-1 text-xs" aria-label={label}>
      <option value="">{emptyText}</option>
      {source.columns.map((c) => (
        <option key={c.key} value={c.key}>
          {c.label}
        </option>
      ))}
    </select>
  );

  const sample = (col: string) => {
    if (!col) return '';
    const v = source.rows.map((r) => r.data[col] ?? '').find((x) => x.trim());
    return v ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : '(empty)';
  };

  return (
    <div className="mb-4 rounded-md border border-primary/40 bg-primary/5 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium">
            {total} row{total !== 1 ? 's' : ''} from <span className="font-semibold">{source.label}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Columns are matched to the document by name. Change any match below.
            {linked > 0 && ` Signing status, signed date and the signed document link are written back to ${linked === total ? 'each row' : `${linked} linked rows`}.`}
          </p>
        </div>
        <button type="button" onClick={onClear} className="text-xs text-muted-foreground hover:text-foreground">
          Don&apos;t use these rows
        </button>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-muted-foreground">
          Signer name
          {select(mapping.nameColumn, (v) => onChange({ ...mapping, nameColumn: v }), 'Signer name column')}
          {mapping.nameColumn && <span className="mt-0.5 block truncate">e.g. {sample(mapping.nameColumn)}</span>}
        </label>
        <label className="text-[11px] text-muted-foreground">
          Signer email
          {select(mapping.emailColumn, (v) => onChange({ ...mapping, emailColumn: v }), 'Signer email column')}
          {mapping.emailColumn && <span className="mt-0.5 block truncate">e.g. {sample(mapping.emailColumn)}</span>}
        </label>
        {extraSigners.map((s) => {
          const cols = mapping.signers[s.index] ?? { nameColumn: '', emailColumn: '' };
          const set = (patch: Partial<typeof cols>) => onChange({ ...mapping, signers: { ...mapping.signers, [s.index]: { ...cols, ...patch } } });
          return (
            <div key={s.index} className="contents">
              <label className="text-[11px] text-muted-foreground">
                {s.role} name
                {select(cols.nameColumn, (v) => set({ nameColumn: v }), `${s.role} name column`)}
              </label>
              <label className="text-[11px] text-muted-foreground">
                {s.role} email
                {select(cols.emailColumn, (v) => set({ emailColumn: v }), `${s.role} email column`)}
              </label>
            </div>
          );
        })}
      </div>

      {fieldDefs.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded border bg-background">
          <table className="w-full text-xs">
            <thead className="bg-muted text-left uppercase text-muted-foreground">
              <tr>
                <th className="px-2 py-1">Document field</th>
                <th className="px-2 py-1">Column</th>
                <th className="px-2 py-1">Example</th>
              </tr>
            </thead>
            <tbody>
              {fieldDefs.map((fd) => {
                const col = mapping.fields[fd.key] ?? '';
                return (
                  <tr key={fd.key} className="border-t border-border-subtle">
                    <td className="px-2 py-1">
                      <code className="font-mono text-primary">{fd.key}</code>
                    </td>
                    <td className="px-2 py-1 min-w-[180px]">
                      {select(col, (v) => onChange({ ...mapping, fields: { ...mapping.fields, [fd.key]: v } }), `Column for ${fd.key}`, '— signer fills —')}
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">{col ? sample(col) : <span className="text-amber-700">Signer fills</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(!mapping.nameColumn || !mapping.emailColumn) && (
        <p className="mt-2 text-xs text-destructive">Choose the columns that hold the signer&apos;s name and email.</p>
      )}
      {mapping.nameColumn && mapping.emailColumn && skipped > 0 && (
        <p className="mt-2 text-xs text-amber-700">
          {skipped} row{skipped !== 1 ? 's have' : ' has'} no name or email and will be skipped.
        </p>
      )}
    </div>
  );
}
