'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { callAi, useAiStatus, UsageLine } from '@/components/ai/useAi';

interface Generated {
  subject: string;
  previewText: string;
  plainText: string;
  html: string;
  usedVariables: string[];
}

interface Personalization {
  score: number;
  findings: string[];
  suggestions: string[];
  usedVariables: string[];
  missingVariables: string[];
}

const IMPROVE_ACTIONS: { mode: string; label: string }[] = [
  { mode: 'improve', label: 'Improve' },
  { mode: 'shorten', label: 'Shorten' },
  { mode: 'professional', label: 'More professional' },
  { mode: 'friendly', label: 'More friendly' },
  { mode: 'grammar', label: 'Fix grammar' },
  { mode: 'cta', label: 'Add a CTA' },
  { mode: 'rewrite', label: 'Rewrite' },
  { mode: 'translate', label: 'Translate to Hindi' },
];

/**
 * §76/§77 writing assistant for the template editor. Everything it produces
 * lands in the editor only when the user clicks Insert / Apply — it never
 * saves a version and never sends.
 */
export function AiWriter({
  subject,
  html,
  variables,
  onApply,
}: {
  subject: string;
  html: string;
  variables: string[];
  onApply: (patch: { subject?: string; html?: string }) => void;
}) {
  const { status, bump } = useAiStatus();
  const [brief, setBrief] = useState('');
  const [tone, setTone] = useState<'professional' | 'friendly' | 'urgent' | 'neutral'>('professional');
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Generated | null>(null);
  const [subjects, setSubjects] = useState<string[] | null>(null);
  const [check, setCheck] = useState<Personalization | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const disabled = status ? !status.enabled : false;

  async function run<T>(label: string, body: Record<string, unknown>, onOk: (data: T) => void) {
    setBusy(label);
    setNotice(null);
    const r = await callAi<T>(body);
    setBusy(null);
    if (!r.ok) {
      setNotice(r.message);
      return;
    }
    bump(r.usage.userToday);
    onOk(r.data);
  }

  function generate() {
    if (brief.trim().length < 3) {
      toast.error('Describe the email first, e.g. "reminder for students who have not completed RPG".');
      return;
    }
    run<Generated>('generate', { action: 'generate_email', brief, tone, variables }, (d) => setDraft(d));
  }

  function refineDraft(mode: 'shorten' | 'professional') {
    if (!draft) return;
    run<{ text: string; changes: string[] }>(mode, { action: 'improve_text', text: draft.html, mode, format: 'html', variables }, (d) =>
      setDraft({ ...draft, html: d.text })
    );
  }

  function improveCurrent(mode: string) {
    if (!html.trim()) {
      toast.error('The template body is empty.');
      return;
    }
    run<{ text: string; changes: string[] }>(mode, { action: 'improve_text', text: html, mode, format: 'html', language: mode === 'translate' ? 'Hindi' : undefined, variables }, (d) => {
      onApply({ html: d.text });
      toast.success(d.changes.length ? d.changes.slice(0, 3).join(' · ') : 'Applied to the editor');
    });
  }

  function subjectIdeas() {
    run<string[]>('subjects', { action: 'subject_lines', brief: brief.trim() || subject || 'this email', body: html, variables }, (d) => setSubjects(d));
  }

  function checkPersonalization() {
    if (!html.trim()) {
      toast.error('The template body is empty.');
      return;
    }
    run<Personalization>('check', { action: 'check_personalization', subject, body: html, variables }, (d) => setCheck(d));
  }

  return (
    <div className="mt-4 rounded-md border border-border-subtle bg-elevated/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">AI assistant</h2>
        <UsageLine status={status} />
      </div>

      {disabled ? (
        <p className="text-xs text-muted-foreground">AI is off for this deployment. Everything else works as normal.</p>
      ) : (
        <>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder='Describe the email, e.g. "professional reminder for students who have not completed RPG, deadline in {{Deadline}}"'
            className="w-full text-xs"
          />
          <div className="mt-2 flex items-center gap-2">
            <select value={tone} onChange={(e) => setTone(e.target.value as any)} className="text-xs">
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="urgent">Urgent</option>
              <option value="neutral">Neutral</option>
            </select>
            <button onClick={generate} disabled={!!busy} className="btn-primary flex-1 !py-1.5 text-xs">
              {busy === 'generate' ? 'Writing…' : draft ? 'Regenerate' : 'Generate email'}
            </button>
          </div>

          {draft && (
            <div className="mt-3 rounded-md border border-border bg-card p-2 text-xs">
              <div className="font-medium">{draft.subject}</div>
              <div className="mt-0.5 text-faint">{draft.previewText}</div>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-muted-foreground">{draft.plainText}</pre>
              {draft.usedVariables.length > 0 && (
                <div className="mt-1 text-faint">Uses {draft.usedVariables.map((v) => `{{${v}}}`).join(', ')}</div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  onClick={() => {
                    onApply({ subject: draft.subject, html: draft.html });
                    toast.success('Inserted into the editor — review before saving');
                  }}
                  className="btn-primary !py-1 text-[11px]"
                >
                  Insert
                </button>
                <button onClick={() => refineDraft('shorten')} disabled={!!busy} className="btn-secondary !py-1 text-[11px]">
                  {busy === 'shorten' ? '…' : 'Make shorter'}
                </button>
                <button onClick={() => refineDraft('professional')} disabled={!!busy} className="btn-secondary !py-1 text-[11px]">
                  {busy === 'professional' ? '…' : 'More professional'}
                </button>
                <button onClick={() => setDraft(null)} className="text-[11px] text-muted-foreground hover:text-foreground">
                  Discard
                </button>
              </div>
            </div>
          )}

          <div className="mt-3">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">Improve the current body</div>
            <div className="flex flex-wrap gap-1">
              {IMPROVE_ACTIONS.map((a) => (
                <button key={a.mode} onClick={() => improveCurrent(a.mode)} disabled={!!busy} className="btn-secondary !px-2 !py-0.5 text-[11px] normal-case tracking-normal">
                  {busy === a.mode ? '…' : a.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 flex gap-1.5">
            <button onClick={subjectIdeas} disabled={!!busy} className="btn-secondary flex-1 !py-1 text-[11px]">
              {busy === 'subjects' ? '…' : 'Subject ideas'}
            </button>
            <button onClick={checkPersonalization} disabled={!!busy} className="btn-secondary flex-1 !py-1 text-[11px]">
              {busy === 'check' ? '…' : 'Check personalisation'}
            </button>
          </div>

          {subjects && (
            <ul className="mt-2 space-y-1 text-xs">
              {subjects.map((s) => (
                <li key={s}>
                  <button onClick={() => onApply({ subject: s })} className="text-left hover:text-primary" title="Use this subject">
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {check && (
            <div className="mt-2 rounded-md border border-border bg-card p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium">Personalisation score</span>
                <span className={`font-heading text-base font-bold ${check.score >= 70 ? 'text-success' : check.score >= 40 ? 'text-warning' : 'text-primary'}`}>{check.score}</span>
              </div>
              {check.missingVariables.length > 0 && (
                <div className="mt-1 text-warning">Missing on the dataset: {check.missingVariables.map((v) => `{{${v}}}`).join(', ')}</div>
              )}
              {check.findings.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                  {check.findings.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
              {check.suggestions.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {check.suggestions.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {notice && <p className="mt-2 text-xs text-warning">{notice}</p>}
          <p className="mt-2 text-[11px] text-faint">Suggestions only. Nothing is saved or sent until you do it.</p>
        </>
      )}
    </div>
  );
}
