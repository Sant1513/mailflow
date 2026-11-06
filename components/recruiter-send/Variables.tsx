'use client';

import { BUILT_IN_VARIABLES, knownVariables, squash, variablesIn } from '@/lib/recruiterSend/personalize';

/** What is wrong with the {{variables}} in the subject/message, in words (empty = fine). */
export function variableProblems(input: { columns: string[]; mode: string; subject: string; body: string }): string[] {
  const used = variablesIn(input.subject, input.body);
  if (!used.length) return [];
  const known = knownVariables(input.columns);
  const unknown = used.filter((v) => !known.has(squash(v.name))).map((v) => `{{${v.name}}}`);
  const out: string[] = [];
  if (unknown.length) out.push(`${unknown.join(', ')} ${unknown.length === 1 ? 'is not a column' : 'are not columns'} in your recruiter list.`);
  if (input.mode === 'BCC') out.push('{{Variables}} need “Individual copies” (step 2): a BCC email is one message for many recruiters.');
  return out;
}

/**
 * Click-to-insert {{Column}} chips under the message: the list's columns plus Email, Name and
 * First name. Inserts where the cursor was (subject or message).
 */
export function VariablePicker({
  columns,
  emailColumn,
  format,
  mode,
  subject,
  body,
  onInsert,
  onIndividual,
}: {
  columns: string[];
  emailColumn: string | null;
  format: 'text' | 'html';
  mode: 'BCC' | 'INDIVIDUAL';
  subject: string;
  body: string;
  onInsert: (token: string) => void;
  onIndividual: () => void;
}) {
  const fromList = columns.filter((c) => c !== emailColumn);
  const builtIns = BUILT_IN_VARIABLES.filter((b) => !columns.some((c) => squash(c) === squash(b)));
  const problems = variableProblems({ columns, mode, subject, body });
  const used = variablesIn(subject, body);
  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 font-medium">Personalise</span>
        {[...fromList, ...builtIns].map((c) => (
          <button
            key={c}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onInsert(`{{${c}}}`)}
            className="rounded bg-background px-1.5 py-0.5 font-mono ring-1 ring-border transition hover:bg-primary hover:text-primary-foreground"
            title={`Insert {{${c}}}`}
          >
            {`{{${c}}}`}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-muted-foreground">
        Each recruiter gets their own value. {fromList.length === 0 && 'Paste the list with its header row to use your own columns (company, UTM link…). '}
        Empty values: write a fallback, <code>{'{{First name | there}}'}</code>, or that recruiter is skipped.
        {format === 'html'
          ? <> Per-recruiter links: <code>{'<a href="{{UTM link}}">Apply</a>'}</code>.</>
          : <> A column holding a link becomes a clickable link.</>}
      </p>
      {used.length > 0 && problems.length === 0 && (
        <p className="mt-1 text-green-700 dark:text-green-400">Using {used.map((v) => `{{${v.name}}}`).join(', ')}. The preview shows the first recruiter’s values.</p>
      )}
      {problems.map((p) => (
        <p key={p} className="mt-1 text-red-600 dark:text-red-400">
          {p}
          {p.includes('Individual copies') && (
            <button type="button" onClick={onIndividual} className="ml-2 rounded border border-current px-1.5 py-0.5 hover:bg-red-50 dark:hover:bg-red-950">Switch to individual copies</button>
          )}
        </p>
      ))}
    </div>
  );
}
