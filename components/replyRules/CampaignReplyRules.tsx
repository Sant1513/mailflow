'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { REPLY_TYPES, exampleReplyRules, type ReplyRule, type ReplyRules, type ReplyType } from '@/lib/replyRules/config';

interface Option { id: string; name: string | null; email?: string }

const input = 'w-full rounded border bg-background px-2 py-1.5 text-sm';

const blankRule = (id: string): ReplyRule => ({
  id,
  when: ['INTERESTED'],
  minConfidence: 0.7,
  actions: { replyTemplateId: null, replyMode: 'draft', setColumn: null, setValue: '', assignTo: null, addTag: null, setStatus: null, stopFollowUps: false, unsubscribe: false, notifyOwner: false },
});

/** Campaign page → "When someone replies": follow-up branches by the type of reply. */
export function CampaignReplyRules({ campaignId, canEdit }: { campaignId: string; canEdit: boolean }) {
  const [rules, setRules] = useState<ReplyRules | null>(null);
  const [saved, setSaved] = useState('');
  const [templates, setTemplates] = useState<Option[]>([]);
  const [members, setMembers] = useState<Option[]>([]);
  const [columns, setColumns] = useState<{ key: string; label: string }[]>([]);
  const [applied, setApplied] = useState(0);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/campaigns/${campaignId}/reply-rules`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        setRules(j.rules);
        setSaved(JSON.stringify(j.rules));
        setTemplates(j.templates ?? []);
        setMembers(j.members ?? []);
        setColumns(j.columns ?? []);
        setApplied(j.applied ?? 0);
        setAiEnabled(j.aiEnabled !== false);
      })
      .catch(() => undefined);
  }, [campaignId]);

  if (!rules) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const setRule = (i: number, patch: Partial<ReplyRule>) => setRules({ ...rules, rules: rules.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const setAction = (i: number, patch: Partial<ReplyRule['actions']>) =>
    setRules({ ...rules, rules: rules.rules.map((r, j) => (j === i ? { ...r, actions: { ...r.actions, ...patch } } : r)) });
  const dirty = JSON.stringify(rules) !== saved;

  async function save() {
    setSaving(true);
    const res = await fetch(`/api/campaigns/${campaignId}/reply-rules`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rules) }).catch(() => null);
    setSaving(false);
    const j = await res?.json().catch(() => ({}));
    if (res?.ok) {
      setSaved(JSON.stringify(rules));
      toast.success('Reply rules saved.');
    } else toast.error(j?.error ?? 'Could not save the reply rules.');
  }

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-muted-foreground">
        MailFlow&apos;s AI reads every reply to this campaign and decides what kind it is. The first rule that matches runs its actions,
        and a note in the conversation says what was done.{applied ? ` Used ${applied} time${applied === 1 ? '' : 's'} so far.` : ''}
        {!aiEnabled && <b className="text-red-600"> The AI is switched off, so these rules can&apos;t run.</b>}
      </p>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={rules.enabled} disabled={!canEdit} onChange={(e) => setRules({ ...(rules.rules.length ? rules : exampleReplyRules()), enabled: e.target.checked })} />
        Act on replies automatically
      </label>

      {rules.enabled &&
        rules.rules.map((rule, i) => (
          <fieldset key={rule.id} disabled={!canEdit} className="space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-xs text-muted-foreground">Rule {i + 1}</legend>
            <div>
              <span className="mb-1 block text-xs font-medium">When the reply…</span>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(REPLY_TYPES) as ReplyType[]).map((t) => {
                  const on = rule.when.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setRule(i, { when: on ? rule.when.filter((x) => x !== t).length ? rule.when.filter((x) => x !== t) : rule.when : [...rule.when, t] })}
                      className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-elevated'}`}
                    >
                      {REPLY_TYPES[t]}
                    </button>
                  );
                })}
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                and the AI is at least
                <select value={rule.minConfidence} onChange={(e) => setRule(i, { minConfidence: Number(e.target.value) })} className="rounded border bg-background px-1 py-0.5">
                  {[0.5, 0.6, 0.7, 0.8, 0.9].map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}
                </select>
                sure
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium">Reply with a template</span>
                <select value={rule.actions.replyTemplateId ?? ''} onChange={(e) => setAction(i, { replyTemplateId: e.target.value || null })} className={input}>
                  <option value="">Don&apos;t reply</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                {rule.actions.replyTemplateId && (
                  <select value={rule.actions.replyMode} onChange={(e) => setAction(i, { replyMode: e.target.value as 'draft' | 'auto' })} className={`${input} mt-1`}>
                    <option value="draft">Draft it for approval (Inbox → Approve &amp; send)</option>
                    <option value="auto">Send it automatically, in the same thread</option>
                  </select>
                )}
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium">Assign the conversation to</span>
                <select value={rule.actions.assignTo ?? ''} onChange={(e) => setAction(i, { assignTo: e.target.value || null })} className={input}>
                  <option value="">Leave as is</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.email}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium">Write to a data column</span>
                <span className="flex gap-2">
                  <input list={`cols-${rule.id}`} value={rule.actions.setColumn ?? ''} onChange={(e) => setAction(i, { setColumn: e.target.value || null })} className={input} placeholder="Column, e.g. Reply status" maxLength={100} />
                  <input value={rule.actions.setValue} onChange={(e) => setAction(i, { setValue: e.target.value })} className={input} placeholder="Value, e.g. Interested" maxLength={500} disabled={!rule.actions.setColumn} />
                </span>
                <datalist id={`cols-${rule.id}`}>{columns.map((c) => <option key={c.key} value={c.label} />)}</datalist>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium">Then set the conversation to</span>
                <select value={rule.actions.setStatus ?? ''} onChange={(e) => setAction(i, { setStatus: (e.target.value || null) as ReplyRule['actions']['setStatus'] })} className={input}>
                  <option value="">Leave as is</option>
                  <option value="IN_PROGRESS">In progress</option>
                  <option value="WAITING_FOR_STUDENT">Waiting for student</option>
                  <option value="RESOLVED">Resolved</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium">Add a tag</span>
                <input value={rule.actions.addTag ?? ''} onChange={(e) => setAction(i, { addTag: e.target.value || null })} className={input} maxLength={40} placeholder="e.g. Hot lead" />
              </label>
              <div className="space-y-1.5 pt-1">
                <label className="flex items-center gap-2"><input type="checkbox" checked={rule.actions.stopFollowUps} onChange={(e) => setAction(i, { stopFollowUps: e.target.checked })} />Stop follow-ups for this person</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={rule.actions.unsubscribe} onChange={(e) => setAction(i, { unsubscribe: e.target.checked })} />Don&apos;t email them again (unsubscribe)</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={rule.actions.notifyOwner} onChange={(e) => setAction(i, { notifyOwner: e.target.checked })} />Notify me</label>
              </div>
            </div>

            <div className="flex gap-2">
              <button type="button" disabled={i === 0} onClick={() => { const r = [...rules.rules]; [r[i - 1], r[i]] = [r[i]!, r[i - 1]!]; setRules({ ...rules, rules: r }); }} className="rounded px-2 py-1 text-xs hover:bg-elevated disabled:opacity-40" aria-label="Move rule up">↑</button>
              <button type="button" disabled={i === rules.rules.length - 1} onClick={() => { const r = [...rules.rules]; [r[i + 1], r[i]] = [r[i]!, r[i + 1]!]; setRules({ ...rules, rules: r }); }} className="rounded px-2 py-1 text-xs hover:bg-elevated disabled:opacity-40" aria-label="Move rule down">↓</button>
              <button type="button" onClick={() => setRules({ ...rules, rules: rules.rules.filter((_, j) => j !== i) })} className="ml-auto rounded px-2 py-1 text-xs text-red-600 hover:bg-elevated">Remove rule</button>
            </div>
          </fieldset>
        ))}

      {canEdit && rules.enabled && rules.rules.length < 12 && (
        <button type="button" onClick={() => setRules({ ...rules, rules: [...rules.rules, blankRule(`rule_${Date.now().toString(36)}`)] })} className="rounded border px-3 py-1.5 text-xs hover:bg-elevated">
          + Add a rule
        </button>
      )}

      {canEdit && dirty && (
        <div>
          <button type="button" disabled={saving} onClick={save} className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {saving ? 'Saving…' : 'Save reply rules'}
          </button>
        </div>
      )}
    </div>
  );
}
