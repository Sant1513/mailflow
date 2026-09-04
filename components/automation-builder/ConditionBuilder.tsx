'use client';

const OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

const NO_VALUE_OPERATORS = new Set(['is_empty', 'is_not_empty']);

export interface Rule {
  field: string;
  operator: string;
  value?: unknown;
}

export interface Group {
  op: 'AND' | 'OR';
  rules: Rule[];
}

/** §69 condition builder. Flat AND/OR list — nesting is supported by the
 * engine but deliberately not exposed yet, to keep the UI legible. */
export function ConditionBuilder({
  group,
  columns,
  onChange,
  label,
}: {
  group: Group;
  columns: string[];
  onChange: (next: Group) => void;
  label: string;
}) {
  function update(index: number, patch: Partial<Rule>) {
    const rules = group.rules.map((r, i) => (i === index ? { ...r, ...patch } : r));
    onChange({ ...group, rules });
  }

  function addRule() {
    onChange({ ...group, rules: [...group.rules, { field: columns[0] ?? '', operator: 'equals', value: '' }] });
  }

  function removeRule(index: number) {
    onChange({ ...group, rules: group.rules.filter((_, i) => i !== index) });
  }

  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-muted-foreground">{label}</span>
        {group.rules.length > 1 && (
          <select
            value={group.op}
            onChange={(e) => onChange({ ...group, op: e.target.value as 'AND' | 'OR' })}
            className="rounded border px-1.5 py-0.5 text-xs"
          >
            <option value="AND">Match ALL (AND)</option>
            <option value="OR">Match ANY (OR)</option>
          </select>
        )}
      </div>

      {group.rules.length === 0 ? (
        <p className="mb-2 text-xs text-muted-foreground">
          No conditions — this would match <strong>every record</strong> in the dataset.
        </p>
      ) : (
        <div className="space-y-2">
          {group.rules.map((rule, index) => (
            <div key={index} className="flex flex-wrap items-center gap-1.5">
              {index > 0 && <span className="w-10 text-xs text-muted-foreground">{group.op}</span>}
              <select
                value={rule.field}
                onChange={(e) => update(index, { field: e.target.value })}
                className="rounded border px-1.5 py-1 text-xs"
              >
                <option value="">field…</option>
                {columns.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <select
                value={rule.operator}
                onChange={(e) => update(index, { operator: e.target.value })}
                className="rounded border px-1.5 py-1 text-xs"
              >
                {OPERATORS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {!NO_VALUE_OPERATORS.has(rule.operator) && (
                <input
                  value={String(rule.value ?? '')}
                  onChange={(e) => update(index, { value: e.target.value })}
                  placeholder="value"
                  className="w-28 rounded border px-1.5 py-1 text-xs"
                />
              )}
              <button onClick={() => removeRule(index)} className="text-xs text-muted-foreground hover:text-destructive">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <button onClick={addRule} className="mt-2 rounded border px-2 py-1 text-xs hover:bg-muted">
        + Add condition
      </button>
    </div>
  );
}
