'use client';

import { useMemo } from 'react';
import { defaultRsvpConfig, renderRsvpBlock, type RsvpConfig, type RsvpOption } from '@/lib/rsvp/config';

/**
 * Every RSVP setting, with a live preview of the buttons as they will look in the email.
 * Controlled: the parent owns the value (campaign page or Quick Send).
 */

const PRESETS: Omit<RsvpOption, 'key'>[] = [
  { label: "Yes, I'll attend", emoji: '✅', background: '#16a34a', textColor: '#ffffff', capacity: null, confirmTitle: 'Thanks — see you there!', confirmMessage: "We've noted that you'll attend.", askNote: false, notePrompt: '' },
  { label: "Can't make it", emoji: '❌', background: '#dc2626', textColor: '#ffffff', capacity: null, confirmTitle: 'Thanks for letting us know', confirmMessage: "We've noted that you can't attend.", askNote: true, notePrompt: 'Anything we should know? (optional)' },
  { label: 'Maybe', emoji: '🤔', background: '#d97706', textColor: '#ffffff', capacity: null, confirmTitle: 'Thanks', confirmMessage: "We've noted that you might attend. You can change your answer any time before the deadline.", askNote: false, notePrompt: '' },
  { label: 'Interested', emoji: '👍', background: '#2563eb', textColor: '#ffffff', capacity: null, confirmTitle: 'Great!', confirmMessage: "We've noted your interest.", askNote: false, notePrompt: '' },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'option';

function uniqueKey(label: string, taken: string[]): string {
  const base = slug(label);
  let key = base;
  for (let i = 2; taken.includes(key); i++) key = `${base.slice(0, 21)}_${i}`;
  return key;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const input = 'w-full rounded border bg-background px-2 py-1.5 text-sm';
const small = 'text-xs text-muted-foreground';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium">{label}</span>
      {children}
      {hint && <span className={`mt-1 block ${small}`}>{hint}</span>}
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <span className="flex items-center gap-2">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-10 cursor-pointer rounded border bg-background p-0.5" aria-label={label} />
        <input value={value} onChange={(e) => onChange(e.target.value)} className={`${input} font-mono`} maxLength={7} aria-label={`${label} (hex)`} />
      </span>
    </Field>
  );
}

export function RsvpEditor({
  value,
  onChange,
  columns = [],
  lockedKeys = [],
}: {
  value: RsvpConfig;
  onChange: (next: RsvpConfig) => void;
  /** The data's columns, for "save the answer to a column". */
  columns?: { key: string; label: string }[];
  /** Answer keys already in sent emails: can't be removed. */
  lockedKeys?: string[];
}) {
  const set = <K extends keyof RsvpConfig>(k: K, v: RsvpConfig[K]) => onChange({ ...value, [k]: v });
  const setOption = (i: number, patch: Partial<RsvpOption>) =>
    onChange({ ...value, options: value.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  const preview = useMemo(() => renderRsvpBlock(value, () => '#'), [value]);

  if (!value.enabled) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Add buttons like “✅ I&apos;ll attend / ❌ Can&apos;t make it”. Answers are collected here and can be saved to the data.</p>
        <button type="button" onClick={() => onChange({ ...(value.options.length ? value : defaultRsvpConfig()), enabled: true })} className="rounded border px-3 py-1.5 text-sm hover:bg-elevated">
          Add RSVP buttons
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={small}>
          The buttons appear where the email contains <code className="rounded bg-muted px-1">[[rsvp]]</code>, otherwise at the end. Each person gets their own links.
        </p>
        <button type="button" onClick={() => set('enabled', false)} className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-elevated">
          Remove RSVP
        </button>
      </div>

      {/* Live preview */}
      <div>
        <span className="mb-1 block text-xs font-medium">Preview</span>
        <div className="rounded border bg-white p-3 text-black" dangerouslySetInnerHTML={{ __html: preview }} />
      </div>

      {/* Question */}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Question (above the buttons)">
          <input value={value.question} onChange={(e) => set('question', e.target.value)} className={input} maxLength={300} placeholder="Will you attend the placement drive on 12 Nov?" />
        </Field>
        <ColorField label="Question colour" value={value.questionColor} onChange={(v) => set('questionColor', v)} />
      </div>

      {/* Answers */}
      <div className="space-y-3">
        <span className="block text-xs font-medium">Answers (up to 4)</span>
        {value.options.map((o, i) => {
          const locked = lockedKeys.includes(o.key);
          return (
            <fieldset key={o.key} className="space-y-3 rounded-lg border p-3">
              <legend className="px-1 text-xs text-muted-foreground">
                Answer {i + 1} <span className="font-mono">({o.key})</span>
                {locked && ' · already sent, can be edited but not removed'}
              </legend>
              <div className="grid gap-3 sm:grid-cols-[5rem_1fr]">
                <Field label="Emoji">
                  <input value={o.emoji} onChange={(e) => setOption(i, { emoji: e.target.value })} className={input} maxLength={8} placeholder="✅" />
                </Field>
                <Field label="Button text">
                  <input value={o.label} onChange={(e) => setOption(i, { label: e.target.value })} className={input} maxLength={40} />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <ColorField label="Button colour" value={o.background} onChange={(v) => setOption(i, { background: v })} />
                <ColorField label="Text colour" value={o.textColor} onChange={(v) => setOption(i, { textColor: v })} />
                <Field label="Seat limit" hint="Empty = unlimited">
                  <input
                    type="number"
                    min={1}
                    value={o.capacity ?? ''}
                    onChange={(e) => setOption(i, { capacity: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null })}
                    className={input}
                    placeholder="e.g. 120"
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Thank-you title (after answering)">
                  <input value={o.confirmTitle} onChange={(e) => setOption(i, { confirmTitle: e.target.value })} className={input} maxLength={120} />
                </Field>
                <Field label="Thank-you message">
                  <input value={o.confirmMessage} onChange={(e) => setOption(i, { confirmMessage: e.target.value })} className={input} maxLength={1000} />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={o.askNote} onChange={(e) => setOption(i, { askNote: e.target.checked })} />
                  Ask for a note after this answer
                </label>
                {o.askNote && (
                  <input value={o.notePrompt} onChange={(e) => setOption(i, { notePrompt: e.target.value })} className={`${input} sm:w-80`} maxLength={200} placeholder="Anything we should know? (optional)" aria-label="Note question" />
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={i === 0} onClick={() => { const opts = [...value.options]; [opts[i - 1], opts[i]] = [opts[i]!, opts[i - 1]!]; set('options', opts); }} className="rounded px-2 py-1 text-xs hover:bg-elevated disabled:opacity-40" aria-label="Move up">↑</button>
                <button type="button" disabled={i === value.options.length - 1} onClick={() => { const opts = [...value.options]; [opts[i + 1], opts[i]] = [opts[i]!, opts[i + 1]!]; set('options', opts); }} className="rounded px-2 py-1 text-xs hover:bg-elevated disabled:opacity-40" aria-label="Move down">↓</button>
                <button type="button" disabled={locked || value.options.length <= 1} onClick={() => set('options', value.options.filter((_, j) => j !== i))} className="ml-auto rounded px-2 py-1 text-xs text-red-600 hover:bg-elevated disabled:opacity-40">
                  Remove answer
                </button>
              </div>
            </fieldset>
          );
        })}
        {value.options.length < 4 && (
          <div className="flex flex-wrap gap-2">
            <span className={`${small} self-center`}>Add:</span>
            {PRESETS.filter((p) => !value.options.some((o) => o.label === p.label)).map((p) => (
              <button key={p.label} type="button" onClick={() => set('options', [...value.options, { ...p, key: uniqueKey(p.label, value.options.map((o) => o.key)) }])} className="rounded border px-2 py-1 text-xs hover:bg-elevated">
                {p.emoji} {p.label}
              </button>
            ))}
            <button type="button" onClick={() => set('options', [...value.options, { ...PRESETS[3]!, label: 'New answer', emoji: '', key: uniqueKey('answer', value.options.map((o) => o.key)) }])} className="rounded border px-2 py-1 text-xs hover:bg-elevated">
              + Custom
            </button>
          </div>
        )}
      </div>

      {/* Look */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Shape">
          <select value={value.shape} onChange={(e) => set('shape', e.target.value as RsvpConfig['shape'])} className={input}>
            <option value="rounded">Rounded</option>
            <option value="pill">Pill</option>
            <option value="square">Square</option>
          </select>
        </Field>
        <Field label="Size">
          <select value={value.size} onChange={(e) => set('size', e.target.value as RsvpConfig['size'])} className={input}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </Field>
        <Field label="Alignment">
          <select value={value.align} onChange={(e) => set('align', e.target.value as RsvpConfig['align'])} className={input}>
            <option value="left">Left</option>
            <option value="center">Centre</option>
          </select>
        </Field>
        <Field label="Layout">
          <select value={value.layout} onChange={(e) => set('layout', e.target.value as RsvpConfig['layout'])} className={input}>
            <option value="row">Side by side</option>
            <option value="stacked">Stacked</option>
          </select>
        </Field>
      </div>
      <Field label="Small text under the buttons (optional)">
        <input value={value.footnote} onChange={(e) => set('footnote', e.target.value)} className={input} maxLength={300} placeholder="Reply to this email if you have questions." />
      </Field>

      {/* Rules */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Answer by (deadline)" hint="Empty = open until you remove RSVP">
          <input
            type="datetime-local"
            value={toLocalInput(value.deadline)}
            onChange={(e) => set('deadline', e.target.value ? new Date(e.target.value).toISOString() : null)}
            className={input}
          />
        </Field>
        <Field label="After the deadline, show">
          <input value={value.closedMessage} onChange={(e) => set('closedMessage', e.target.value)} className={input} maxLength={500} />
        </Field>
        <Field label="When an answer's seats are full, show">
          <input value={value.fullMessage} onChange={(e) => set('fullMessage', e.target.value)} className={input} maxLength={500} />
        </Field>
        <div className="space-y-2 pt-5">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={value.allowChange} onChange={(e) => set('allowChange', e.target.checked)} />
            People can change their answer
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={value.notifyOwner} onChange={(e) => set('notifyOwner', e.target.checked)} />
            Notify me in MailFlow on each answer
          </label>
        </div>
      </div>

      {/* Where answers go */}
      <Field label="Also save the answer to a column in the data" hint="The answer's text is written to each person's row (with change history). A note goes to “<column> note”.">
        <span className="flex flex-wrap gap-2">
          <select
            value={value.saveToColumn === null ? '' : columns.some((c) => c.label === value.saveToColumn) ? value.saveToColumn : '__new__'}
            onChange={(e) => set('saveToColumn', e.target.value === '' ? null : e.target.value === '__new__' ? 'RSVP' : e.target.value)}
            className={`${input} sm:w-64`}
          >
            <option value="">Don&apos;t save to the data</option>
            {columns.map((c) => (
              <option key={c.key} value={c.label}>
                {c.label}
              </option>
            ))}
            <option value="__new__">New column…</option>
          </select>
          {value.saveToColumn !== null && !columns.some((c) => c.label === value.saveToColumn) && (
            <input value={value.saveToColumn} onChange={(e) => set('saveToColumn', e.target.value || 'RSVP')} className={`${input} sm:w-56`} maxLength={100} aria-label="New column name" />
          )}
        </span>
      </Field>
    </div>
  );
}
