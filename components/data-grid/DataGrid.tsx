'use client';

import { useState } from 'react';
import { toast } from 'sonner';

export interface GridColumn {
  id: string;
  key: string;
  label: string;
  type: string;
  hidden: boolean;
}

export interface GridRecord {
  id: string;
  data: Record<string, unknown>;
  emailStatus: string | null;
  replyReceived: boolean;
  unreadReply: boolean;
}

/**
 * A real, DB-backed, inline-editable spreadsheet grid (§12/§108). Not
 * virtualized yet (fine at hundreds of rows; §135 flags this as a Phase 8
 * follow-up once datasets regularly exceed a few thousand rows).
 */
const COLUMN_TYPES = [
  'TEXT', 'LONG_TEXT', 'EMAIL', 'NUMBER', 'DATE', 'DATETIME',
  'CHECKBOX', 'SINGLE_SELECT', 'MULTI_SELECT', 'URL', 'STATUS',
];

export function DataGrid({
  columns,
  records,
  onCellCommit,
  onDeleteRow,
  onColumnTypeChange,
}: {
  columns: GridColumn[];
  records: GridRecord[];
  onCellCommit: (recordId: string, key: string, value: string) => Promise<void>;
  onDeleteRow: (recordId: string) => Promise<void>;
  /** Import type-inference can guess wrong; this is how a user corrects it. */
  onColumnTypeChange?: (columnId: string, type: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ row: string; col: string } | null>(null);
  const [draft, setDraft] = useState('');
  const visible = columns.filter((c) => !c.hidden);

  async function commit(recordId: string, key: string) {
    setEditing(null);
    await onCellCommit(recordId, key, draft);
  }

  return (
    <div className="overflow-auto rounded-lg border bg-card">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr>
            <th className="grid-cell w-8 text-center text-xs text-muted-foreground">#</th>
            {visible.map((col) => (
              <th key={col.id} className="grid-cell text-left text-xs font-medium">
                <div>{col.label}</div>
                {onColumnTypeChange ? (
                  <select
                    value={col.type}
                    onChange={(e) => onColumnTypeChange(col.id, e.target.value)}
                    className="mt-0.5 rounded border bg-card px-1 py-0.5 text-[10px] font-normal"
                    title="Column type — set the address column to EMAIL to enable sending"
                  >
                    {COLUMN_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                ) : (
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">{col.type}</span>
                )}
              </th>
            ))}
            <th className="grid-cell text-left text-xs font-medium">Email Status</th>
            <th className="grid-cell text-left text-xs font-medium">Reply</th>
            <th className="grid-cell w-8" />
          </tr>
        </thead>
        <tbody>
          {records.map((record, i) => (
            <tr key={record.id} className="hover:bg-muted/40">
              <td className="grid-cell text-center text-xs text-muted-foreground">{i + 1}</td>
              {visible.map((col) => {
                const isEditing = editing?.row === record.id && editing.col === col.key;
                const value = record.data[col.key];
                return (
                  <td
                    key={col.id}
                    className="grid-cell cursor-text"
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
                      <span>{value == null || value === '' ? '' : String(value)}</span>
                    )}
                  </td>
                );
              })}
              <td className="grid-cell">
                <StatusBadge status={record.emailStatus} />
              </td>
              <td className="grid-cell">{record.replyReceived ? (record.unreadReply ? '🔵 Unread' : 'Yes') : '—'}</td>
              <td className="grid-cell">
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
            </tr>
          ))}
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
      ? 'bg-green-100 text-green-800'
      : status === 'FAILED'
        ? 'bg-red-100 text-red-800'
        : 'bg-yellow-100 text-yellow-800';
  return <span className={`rounded px-1.5 py-0.5 text-xs ${color}`}>{status}</span>;
}
