'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

export interface GridColumn {
  id: string;
  key: string;
  label: string;
  type: string;
  hidden: boolean;
  width?: number | null;
}

export interface GridRecord {
  id: string;
  data: Record<string, unknown>;
  emailStatus: string | null;
  replyReceived: boolean;
  unreadReply: boolean;
}

export interface GridSort {
  key: string;
  dir: 'asc' | 'desc';
}

/**
 * §12 Airtable-style grid. DB-backed, inline-editable; supports select /
 * bulk select, group headers, column resize by drag, a frozen first
 * column, sort by clicking a header, duplicate and delete per row. Filter,
 * sort, group and pagination are resolved server-side and passed in —
 * the grid never receives more than one page (§135).
 */
const COLUMN_TYPES = [
  'TEXT', 'LONG_TEXT', 'EMAIL', 'NUMBER', 'DATE', 'DATETIME',
  'CHECKBOX', 'SINGLE_SELECT', 'MULTI_SELECT', 'URL', 'STATUS',
];

const DEFAULT_WIDTH = 160;
const MIN_WIDTH = 60;

export function DataGrid({
  columns,
  records,
  groupOf,
  sort,
  selected,
  freezeFirst,
  rowOffset = 0,
  onCellCommit,
  onDeleteRow,
  onDuplicateRow,
  onColumnTypeChange,
  onColumnResize,
  onSortChange,
  onSelectionChange,
}: {
  columns: GridColumn[];
  records: GridRecord[];
  /** Group value per record (same order), when grouping is on. */
  groupOf?: string[] | null;
  sort?: GridSort[];
  selected: Set<string>;
  freezeFirst?: boolean;
  /** Row number of the first record on this page (for numbering across pages). */
  rowOffset?: number;
  onCellCommit: (recordId: string, key: string, value: string) => Promise<void>;
  onDeleteRow: (recordId: string) => Promise<void>;
  onDuplicateRow?: (recordId: string) => Promise<void>;
  /** Import type-inference can guess wrong; this is how a user corrects it. */
  onColumnTypeChange?: (columnId: string, type: string) => Promise<void>;
  onColumnResize?: (columnId: string, width: number) => void;
  onSortChange?: (key: string) => void;
  onSelectionChange: (next: Set<string>) => void;
}) {
  const [editing, setEditing] = useState<{ row: string; col: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [widths, setWidths] = useState<Record<string, number>>({});
  const resizing = useRef<{ id: string; startX: number; startW: number } | null>(null);
  const visible = columns.filter((c) => !c.hidden);

  useEffect(() => {
    setWidths(Object.fromEntries(columns.map((c) => [c.id, c.width ?? DEFAULT_WIDTH])));
  }, [columns]);

  useEffect(() => {
    function move(e: MouseEvent) {
      const r = resizing.current;
      if (!r) return;
      setWidths((w) => ({ ...w, [r.id]: Math.max(MIN_WIDTH, r.startW + e.clientX - r.startX) }));
    }
    function up() {
      const r = resizing.current;
      if (!r) return;
      resizing.current = null;
      setWidths((w) => {
        onColumnResize?.(r.id, w[r.id] ?? DEFAULT_WIDTH);
        return w;
      });
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [onColumnResize]);

  async function commit(recordId: string, key: string) {
    setEditing(null);
    await onCellCommit(recordId, key, draft);
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  }

  const allOnPageSelected = records.length > 0 && records.every((r) => selected.has(r.id));
  function toggleAll() {
    const next = new Set(selected);
    if (allOnPageSelected) records.forEach((r) => next.delete(r.id));
    else records.forEach((r) => next.add(r.id));
    onSelectionChange(next);
  }

  const sortOf = (key: string) => sort?.find((s) => s.key === key);
  const frozenClass = (i: number) => (freezeFirst && i === 0 ? 'sticky left-10 z-[5] bg-card shadow-[inset_-1px_0_0_hsl(var(--border))]' : '');

  return (
    <div className="h-full overflow-auto rounded-lg border bg-card">
      <table className="border-collapse text-sm" style={{ minWidth: '100%' }}>
        <thead className="sticky top-0 z-10 bg-muted">
          <tr>
            <th className="grid-cell sticky left-0 z-[6] w-10 bg-muted text-center">
              <input type="checkbox" checked={allOnPageSelected} onChange={toggleAll} aria-label="Select all rows on this page" />
            </th>
            {visible.map((col, i) => {
              const s = sortOf(col.key);
              return (
                <th
                  key={col.id}
                  className={`grid-cell relative select-none text-left text-xs font-medium ${frozenClass(i)} ${freezeFirst && i === 0 ? '!bg-muted' : ''}`}
                  style={{ width: widths[col.id] ?? DEFAULT_WIDTH, minWidth: widths[col.id] ?? DEFAULT_WIDTH, maxWidth: widths[col.id] ?? DEFAULT_WIDTH }}
                >
                  <button
                    onClick={() => onSortChange?.(col.key)}
                    className="flex w-full items-center gap-1 text-left hover:text-primary"
                    title="Click to sort"
                  >
                    <span className="truncate">{col.label}</span>
                    {s && <span className="text-primary">{s.dir === 'asc' ? '↑' : '↓'}</span>}
                  </button>
                  {onColumnTypeChange ? (
                    <select
                      value={col.type}
                      onChange={(e) => onColumnTypeChange(col.id, e.target.value)}
                      className="mt-0.5 !w-auto rounded border bg-card !px-1 !py-0.5 text-[10px] font-normal"
                      title="Column type — set the address column to EMAIL to enable sending"
                    >
                      {COLUMN_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="ml-1 text-[10px] font-normal text-muted-foreground">{col.type}</span>
                  )}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      resizing.current = { id: col.id, startX: e.clientX, startW: widths[col.id] ?? DEFAULT_WIDTH };
                    }}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/60"
                    title="Drag to resize"
                  />
                </th>
              );
            })}
            <th className="grid-cell w-28 text-left text-xs font-medium">Email Status</th>
            <th className="grid-cell w-20 text-left text-xs font-medium">Reply</th>
            <th className="grid-cell w-16" />
          </tr>
        </thead>
        <tbody>
          {records.map((record, i) => {
            const groupValue = groupOf?.[i];
            const newGroup = groupOf && (i === 0 || groupOf[i - 1] !== groupValue);
            const isSelected = selected.has(record.id);
            return [
              newGroup ? (
                <tr key={`g-${i}`} className="bg-elevated/60">
                  <td colSpan={visible.length + 4} className="grid-cell sticky left-0 text-xs font-semibold">
                    <span className="eyebrow !py-0.5">{groupValue === '' ? '(empty)' : groupValue}</span>
                    <span className="ml-2 text-faint">{groupOf.filter((g) => g === groupValue).length} on this page</span>
                  </td>
                </tr>
              ) : null,
              <tr key={record.id} className={`${isSelected ? 'bg-primary/10' : 'hover:bg-elevated/60'}`}>
                <td className={`grid-cell sticky left-0 z-[5] w-10 text-center ${isSelected ? 'bg-primary/10' : 'bg-card'}`}>
                  <label className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground">
                    <input type="checkbox" checked={isSelected} onChange={() => toggle(record.id)} aria-label={`Select row ${rowOffset + i + 1}`} />
                    <span className="hidden sm:inline">{rowOffset + i + 1}</span>
                  </label>
                </td>
                {visible.map((col, ci) => {
                  const isEditing = editing?.row === record.id && editing.col === col.key;
                  const value = record.data[col.key];
                  return (
                    <td
                      key={col.id}
                      className={`grid-cell cursor-text ${frozenClass(ci)} ${isSelected && freezeFirst && ci === 0 ? '!bg-elevated' : ''}`}
                      style={{ width: widths[col.id] ?? DEFAULT_WIDTH, minWidth: widths[col.id] ?? DEFAULT_WIDTH, maxWidth: widths[col.id] ?? DEFAULT_WIDTH }}
                      onDoubleClick={() => {
                        setEditing({ row: record.id, col: col.key });
                        setDraft(value == null ? '' : String(value));
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => commit(record.id, col.key)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commit(record.id, col.key);
                            if (e.key === 'Escape') setEditing(null);
                          }}
                        />
                      ) : (
                        <span className="block truncate" title={value == null ? '' : String(value)}>
                          {value == null || value === '' ? '' : String(value)}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="grid-cell">
                  <StatusBadge status={record.emailStatus} />
                </td>
                <td className="grid-cell">{record.replyReceived ? (record.unreadReply ? '🔵 Unread' : 'Yes') : '—'}</td>
                <td className="grid-cell whitespace-nowrap">
                  {onDuplicateRow && (
                    <button onClick={() => onDuplicateRow(record.id)} className="mr-2 text-xs text-muted-foreground hover:text-foreground" title="Duplicate row">
                      ⧉
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      if (confirm('Delete this row?')) {
                        await onDeleteRow(record.id);
                        toast.success('Row deleted');
                      }
                    }}
                    className="text-xs text-muted-foreground hover:text-destructive"
                    title="Delete row"
                  >
                    ✕
                  </button>
                </td>
              </tr>,
            ];
          })}
          {records.length === 0 && (
            <tr>
              <td colSpan={visible.length + 4} className="grid-cell py-8 text-center text-sm text-muted-foreground">
                No records match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status || status === 'NOT_SENT') {
    return <span className="text-xs text-muted-foreground">Not sent</span>;
  }
  const color =
    status === 'SENT'
      ? 'bg-success/15 text-success'
      : status === 'FAILED'
        ? 'bg-destructive/15 text-primary'
        : 'bg-warning/15 text-warning';
  return <span className={`rounded px-1.5 py-0.5 text-xs ${color}`}>{status}</span>;
}
