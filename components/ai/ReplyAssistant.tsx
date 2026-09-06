'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { callAi, useAiStatus, UsageLine } from '@/components/ai/useAi';

interface Summary {
  summary: string;
  suggestedNextAction: string;
  suggestedStatus: 'OPEN' | 'IN_PROGRESS' | 'WAITING_FOR_STUDENT' | 'RESOLVED' | null;
}

interface Intent {
  intent: string;
  confidence: number;
  reason: string;
}

/**
 * §79 summary card for the conversation sidebar. The suggested status is
 * shown as a button the human presses — it is never applied by itself.
 */
export function AiSummaryCard({
  conversationId,
  currentStatus,
  onApplyStatus,
  latestIntent,
}: {
  conversationId: string;
  currentStatus: string;
  onApplyStatus: (status: string) => void;
  latestIntent: Intent | null;
}) {
  const { status, bump } = useAiStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [intent, setIntent] = useState<Intent | null>(latestIntent);
  const [notice, setNotice] = useState<string | null>(null);

  async function summarize() {
    setBusy('summary');
    setNotice(null);
    const r = await callAi<Summary>({ action: 'summarize_conversation', conversationId });
    setBusy(null);
    if (!r.ok) return setNotice(r.message);
    bump(r.usage.userToday);
    setSummary(r.data);
  }

  async function classify() {
    setBusy('classify');
    setNotice(null);
    const r = await callAi<Intent>({ action: 'classify_reply', conversationId });
    setBusy(null);
    if (!r.ok) return setNotice(r.message);
    bump(r.usage.userToday);
    setIntent(r.data);
  }

  if (status && !status.enabled) return null;

  return (
    <div className="mb-5 rounded-md border border-border-subtle bg-elevated/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">AI summary</h2>
        <UsageLine status={status} />
      </div>

      {summary ? (
        <div className="text-xs">
          <p>{summary.summary}</p>
          <div className="mt-2 rounded-md border border-border bg-card p-2">
            <div className="text-[11px] font-medium text-muted-foreground">Suggested next action</div>
            <div className="mt-0.5">{summary.suggestedNextAction}</div>
            {summary.suggestedStatus && summary.suggestedStatus !== currentStatus && (
              <button
                onClick={() => {
                  onApplyStatus(summary.suggestedStatus as string);
                  toast.success(`Status set to ${summary.suggestedStatus?.replace(/_/g, ' ').toLowerCase()}`);
                }}
                className="btn-secondary mt-2 !py-1 text-[11px]"
              >
                Mark as {summary.suggestedStatus.replace(/_/g, ' ').toLowerCase()}
              </button>
            )}
          </div>
          <button onClick={summarize} disabled={!!busy} className="mt-2 text-[11px] text-muted-foreground hover:text-foreground">
            {busy === 'summary' ? 'Summarising…' : 'Refresh summary'}
          </button>
        </div>
      ) : (
        <button onClick={summarize} disabled={!!busy} className="btn-secondary w-full !py-1.5 text-xs">
          {busy === 'summary' ? 'Summarising…' : 'Summarise conversation'}
        </button>
      )}

      <div className="mt-3 border-t border-border-subtle pt-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">Latest reply intent</span>
          <button onClick={classify} disabled={!!busy} className="text-[11px] text-muted-foreground hover:text-foreground">
            {busy === 'classify' ? 'Classifying…' : intent ? 'Re-classify' : 'Classify'}
          </button>
        </div>
        {intent ? (
          <div className="mt-1">
            <span className="badge badge-info">{intent.intent.replace(/_/g, ' ').toLowerCase()}</span>
            <span className="ml-2 text-faint">{Math.round(intent.confidence * 100)}% · {intent.reason}</span>
          </div>
        ) : (
          <div className="mt-1 text-faint">Not classified yet.</div>
        )}
      </div>

      {notice && <p className="mt-2 text-xs text-warning">{notice}</p>}
      <p className="mt-2 text-[11px] text-faint">Suggestions only — you decide what to apply.</p>
    </div>
  );
}

/**
 * §78 "[ AI Suggest Reply ]" — sits above the composer. The draft goes into
 * the textarea only on Insert; sending stays the same human-only button.
 */
export function ReplyAssistant({
  conversationId,
  onInsert,
}: {
  conversationId: string;
  onInsert: (text: string) => void;
}) {
  const { status, bump } = useAiStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function suggest(style: 'default' | 'shorter' | 'formal') {
    setBusy(style);
    setNotice(null);
    const r = await callAi<{ text: string }>({ action: 'suggest_reply', conversationId, style });
    setBusy(null);
    if (!r.ok) return setNotice(r.message);
    bump(r.usage.userToday);
    setDraft(r.data.text);
  }

  if (status && !status.enabled) return null;

  return (
    <div className="mb-2">
      {draft === null ? (
        <div className="flex items-center gap-2">
          <button onClick={() => suggest('default')} disabled={!!busy} className="btn-secondary !py-1 text-[11px]">
            {busy ? 'Drafting…' : 'AI suggest reply'}
          </button>
          {notice && <span className="text-[11px] text-warning">{notice}</span>}
        </div>
      ) : (
        <div className="rounded-md border border-border-subtle bg-elevated/30 p-2 text-xs">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">AI draft — review before inserting</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-sans">{draft}</pre>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              onClick={() => {
                onInsert(draft);
                setDraft(null);
              }}
              className="btn-primary !py-1 text-[11px]"
            >
              Insert reply
            </button>
            <button onClick={() => suggest('default')} disabled={!!busy} className="btn-secondary !py-1 text-[11px]">
              {busy === 'default' ? '…' : 'Regenerate'}
            </button>
            <button onClick={() => suggest('shorter')} disabled={!!busy} className="btn-secondary !py-1 text-[11px]">
              {busy === 'shorter' ? '…' : 'Make shorter'}
            </button>
            <button onClick={() => suggest('formal')} disabled={!!busy} className="btn-secondary !py-1 text-[11px]">
              {busy === 'formal' ? '…' : 'More formal'}
            </button>
            <button onClick={() => setDraft(null)} className="text-[11px] text-muted-foreground hover:text-foreground">
              Discard
            </button>
          </div>
          {notice && <p className="mt-1 text-[11px] text-warning">{notice}</p>}
        </div>
      )}
    </div>
  );
}
