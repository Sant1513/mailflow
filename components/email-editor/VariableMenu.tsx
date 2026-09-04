'use client';

import { useState } from 'react';

/** §24: "+ Insert Variable" menu, populated from the selected dataset's columns. */
export function VariableMenu({
  columns,
  onInsert,
}: {
  columns: string[];
  onInsert: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full rounded-md border px-2 py-1.5 text-xs hover:bg-muted"
      >
        + Insert variable
      </button>
      {open && (
        <div className="mt-1 rounded-md border bg-card p-1">
          {columns.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              Pick a dataset above to see its columns.
            </div>
          ) : (
            columns.map((c) => (
              <button
                key={c}
                onClick={() => {
                  onInsert(c);
                  setOpen(false);
                }}
                className="block w-full rounded px-2 py-1 text-left font-mono text-[11px] hover:bg-muted"
              >
                {`{{${c}}}`}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
