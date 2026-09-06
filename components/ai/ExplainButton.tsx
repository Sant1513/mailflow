'use client';

import { useState } from 'react';
import { callAi } from '@/components/ai/useAi';

interface Explanation {
  explanation: string;
  nextSteps: string[];
}

/**
 * §76 items 18–20: "Summarize campaign", "Explain failed automation",
 * "Explain why email was sent". One button, one explanation panel; the
 * request body names the action and the row id.
 */
export function ExplainButton({
  request,
  label,
  className,
  compact,
}: {
  request: Record<string, unknown>;
  label: string;
  className?: string;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Explanation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function run() {
    setBusy(true);
    setNotice(null);
    const r = await callAi<Explanation>(request);
    setBusy(false);
    setOpen(true);
    if (!r.ok) return setNotice(r.message);
    setResult(r.data);
  }

  return (
    <span className={compact ? 'inline' : 'block'}>
      <button onClick={run} disabled={busy} className={className ?? 'btn-secondary !py-1 text-[11px]'}>
        {busy ? 'Thinking…' : label}
      </button>
      {open && (result || notice) && (
        <div className={`${compact ? 'absolute z-10 mt-1 w-80' : 'mt-2'} rounded-md border border-border bg-card p-3 text-left text-xs shadow-lg`}>
          {notice ? (
            <p className="text-warning">{notice}</p>
          ) : (
            result && (
              <>
                <p>{result.explanation}</p>
                {result.nextSteps.length > 0 && (
                  <ul className="mt-2 list-disc pl-4 text-muted-foreground">
                    {result.nextSteps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                )}
              </>
            )
          )}
          <button onClick={() => setOpen(false)} className="mt-2 text-[11px] text-muted-foreground hover:text-foreground">
            Close
          </button>
        </div>
      )}
    </span>
  );
}
