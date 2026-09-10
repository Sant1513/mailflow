'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Loaded {
  settings: {
    slackConfigured: boolean;
    slackChannelId: string | null;
    slackNotifyAssignments: boolean;
    slackNotifyResolutions: boolean;
    slackNotifyFollowUps: boolean;
    updatedAt: string | null;
  };
  bot: { ok: boolean; user?: string; team?: string; error?: string };
  channel: { ok: boolean; name?: string; isMember?: boolean; error?: string };
}

/** Slack notifications: channel + switches. The bot token is SLACK_BOT_TOKEN on the server and never shown here. */
export function SlackSettings({ readOnly }: { readOnly: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [channel, setChannel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/integrations');
    if (!res.ok) return toast.error('Could not load Slack settings');
    const j: Loaded = await res.json();
    setData(j);
    setChannel(j.settings.slackChannelId ?? '');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: Record<string, unknown>) {
    setBusy('save');
    const res = await fetch('/api/admin/integrations', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const j = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return toast.error(j.error ?? j.issues?.[0]?.message ?? 'Could not save');
    toast.success('Slack settings saved');
    load();
  }

  async function test() {
    setBusy('test');
    const res = await fetch('/api/admin/integrations', { method: 'POST' });
    const j = await res.json().catch(() => ({}));
    setBusy(null);
    if (j.ok) toast.success('Test message posted to Slack');
    else toast.error(`Slack refused: ${j.error ?? 'unknown error'}`);
  }

  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const s = data.settings;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="rounded-md border border-border-subtle bg-elevated/30 p-3">
          <div className="text-faint">Bot</div>
          {data.bot.ok ? (
            <div><span className="text-success">Connected</span> as <b>{data.bot.user}</b> in {data.bot.team}</div>
          ) : (
            <div className="text-warning">{s.slackConfigured ? `Token rejected: ${data.bot.error}` : 'SLACK_BOT_TOKEN is not set on the server'}</div>
          )}
        </div>
        <div className="rounded-md border border-border-subtle bg-elevated/30 p-3">
          <div className="text-faint">Channel</div>
          {s.slackChannelId ? (
            data.channel.ok ? (
              <div>
                <b>#{data.channel.name}</b> · {data.channel.isMember ? <span className="text-success">bot is a member</span> : <span className="text-warning">bot is not in this channel — invite @{data.bot.user ?? 'the bot'} in Slack</span>}
              </div>
            ) : (
              <div className="text-warning">{data.channel.error ?? 'could not check'}</div>
            )
          ) : (
            <div className="text-muted-foreground">Not set</div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <span className="mb-1 block font-medium">Channel ID</span>
          <input value={channel} onChange={(e) => setChannel(e.target.value.trim().toUpperCase())} placeholder="C0123ABCD" disabled={readOnly} className="w-44 font-mono text-sm" />
        </label>
        <button onClick={() => save({ slackChannelId: channel })} disabled={readOnly || busy !== null || channel === (s.slackChannelId ?? '')} className="btn-primary !py-1.5 text-xs">
          {busy === 'save' ? 'Saving…' : 'Save channel'}
        </button>
        <button onClick={test} disabled={busy !== null || !s.slackChannelId || !data.bot.ok} className="btn-secondary !py-1.5 text-xs">
          {busy === 'test' ? 'Posting…' : 'Send test message'}
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">In Slack: open the channel → channel name → <em>About</em> → Channel ID at the bottom. The bot must be invited to the channel.</p>

      <div className="grid gap-2 sm:grid-cols-3">
        {(
          [
            ['slackNotifyAssignments', 'Assignments', 'Post when a conversation is assigned, mentioning the assignee.'],
            ['slackNotifyResolutions', 'Resolutions', 'Reply in the same thread when it is resolved or closed.'],
            ['slackNotifyFollowUps', 'Follow-ups due', 'Remind in the thread when a follow-up falls due.'],
          ] as const
        ).map(([key, label, hint]) => (
          <label key={key} className="flex items-start gap-2 rounded-md border border-border-subtle p-3 text-xs">
            <input type="checkbox" checked={s[key]} disabled={readOnly || busy !== null} onChange={(e) => save({ [key]: e.target.checked })} className="mt-0.5" />
            <span>
              <span className="block font-medium">{label}</span>
              <span className="text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
