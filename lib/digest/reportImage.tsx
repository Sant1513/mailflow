import React from 'react';
import { ImageResponse } from 'next/og';
import type { DailyActivity } from '@/lib/digest/dailyActivity';
import type { NeedsAttention } from '@/lib/digest/needsAttention';
import { dailyLabel, duration, windowLabel } from '@/lib/digest/dailyEmail';

/**
 * The daily / weekly report as one clean picture (for Slack): every number of the email, none
 * of the clutter. Drawn with Satori (next/og): flex boxes only, no emoji, system-safe colours.
 */
const INK = '#18181b';
const MUTED = '#71717a';
const LINE = '#e7e7ec';
const RED = '#ED0331';
const GREEN = '#15803d';
const W = 1200;

const num = (n: number) => n.toLocaleString('en-IN');

function Tile({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '18px 20px', background: '#ffffff', border: `1px solid ${LINE}`, borderRadius: 14 }}>
      <div style={{ display: 'flex', fontSize: 15, color: MUTED }}>{label}</div>
      <div style={{ display: 'flex', fontSize: 42, fontWeight: 700, color: accent ?? INK, marginTop: 6 }}>{value}</div>
      {sub ? <div style={{ display: 'flex', fontSize: 14, color: MUTED, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: '18px 22px', background: '#ffffff', border: `1px solid ${LINE}`, borderRadius: 14, marginTop: 16 }}>
      <div style={{ display: 'flex', fontSize: 15, fontWeight: 700, color: MUTED, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ cells, bold, widths }: { cells: (string | { text: string; color?: string })[]; bold?: boolean; widths: number[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 34, borderTop: `1px solid ${LINE}` }}>
      {cells.map((c, i) => {
        const text = typeof c === 'string' ? c : c.text;
        const color = typeof c === 'string' ? INK : (c.color ?? INK);
        return (
          <div key={i} style={{ display: 'flex', width: widths[i], justifyContent: i === 0 ? 'flex-start' : 'flex-end', fontSize: 18, fontWeight: bold || i === 0 ? 600 : 400, color }}>
            {text}
          </div>
        );
      })}
    </div>
  );
}

export interface ReportImage { bytes: Uint8Array; width: number; height: number }

export async function renderReportImage(a: DailyActivity, d: NeedsAttention, opts: { test?: boolean; unansweredAfterHours?: number } = {}): Promise<ReportImage> {
  const t = a.totals;
  const weekly = a.kind === 'weekly';
  const users = a.users.filter((u) => u.emails > 0 || u.failed > 0).slice(0, 10);
  const inbox = a.inbox.slice(0, 10);
  const byLauncher = new Map<string, { name: string; emails: number; people: number; mailboxes: number }>();
  for (const p of a.pairs) {
    const g = byLauncher.get(p.launchedBy) ?? { name: p.launchedByName, emails: 0, people: 0, mailboxes: 0 };
    g.emails += p.emails;
    g.people += p.people;
    g.mailboxes += 1;
    byLauncher.set(p.launchedBy, g);
  }
  const launchers = [...byLauncher.values()].slice(0, 8);
  const attention: [string, number][] = [
    [`replies unanswered for over ${opts.unansweredAfterHours ?? 24} hours`, d.unansweredReplies.length],
    ['conversations past their SLA', d.slaBreaches.length],
    ['documents expiring unsigned', d.expiringDocuments.length],
    ['campaigns waiting for approval', d.pendingCampaigns.length],
    ['new users waiting for approval', d.pendingUsers.length],
  ];
  const open = attention.filter(([, n]) => n > 0);
  const segments = a.segments;

  const uW = [370, 130, 130, 220, 110, 110];
  const lW = [560, 200, 200];
  const iW = [420, 120, 120, 120, 150, 150];
  const title = `${opts.test ? '[Test] ' : ''}${weekly ? 'Weekly report' : 'Daily report'}`;

  // Height from what is drawn (Satori needs it up front).
  const rowH = 34;
  const panel = (rows: number) => 18 * 2 + 15 + 8 + (rows + 1) * rowH + 16 + 6;
  let height = 40 + 70 + 24 + 120 + 16 + 40; // padding, header, gap, tiles, gap, footer
  if (weekly && a.previous) height += 34;
  if (segments.length) height += 34 + segments.length * 26;
  if (users.length) height += panel(users.length);
  if (launchers.length) height += panel(launchers.length);
  if (inbox.length) height += panel(inbox.length + 1);
  height += 18 * 2 + 15 + 8 + Math.max(1, open.length) * 30 + 16 + 6;
  height = Math.max(520, height + 20);

  const pct = (n: number, b: number) => (b ? `${n >= b ? 'up' : 'down'} ${Math.abs(Math.round(((n - b) / b) * 100))}%` : n ? 'new' : 'no change');

  const res = new ImageResponse(
    (
      <div style={{ display: 'flex', flexDirection: 'column', width: W, height, padding: 40, background: '#f4f4f7', color: INK, fontFamily: 'sans-serif' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 18, fontWeight: 700, color: RED, letterSpacing: 2, textTransform: 'uppercase' }}>MailFlow by Masai</div>
            <div style={{ display: 'flex', fontSize: 40, fontWeight: 700, marginTop: 4 }}>{`${title} · ${dailyLabel(a)}`}</div>
          </div>
          <div style={{ display: 'flex', fontSize: 17, color: MUTED }}>{weekly ? 'Monday to Sunday (IST)' : `${windowLabel(a)} (IST)`}</div>
        </div>

        <div style={{ display: 'flex', marginTop: 24 }}>
          <Tile label="Emails sent" value={num(t.emails)} />
          <div style={{ display: 'flex', width: 14 }} />
          <Tile label="People reached" value={num(t.people)} />
          <div style={{ display: 'flex', width: 14 }} />
          <Tile label="Failed" value={num(t.failed)} accent={t.failed ? RED : GREEN} />
          <div style={{ display: 'flex', width: 14 }} />
          <Tile label="From others' mailboxes" value={num(t.borrowed)} />
          <div style={{ display: 'flex', width: 14 }} />
          <Tile label="Replies received" value={num(a.inboxTotal.received)} />
          <div style={{ display: 'flex', width: 14 }} />
          <Tile label="Open, waiting for a reply" value={num(a.inboxTotal.pending)} accent={a.inboxTotal.pending ? RED : GREEN} sub={`${num(a.inboxTotal.closed)} closed`} />
        </div>

        {weekly && a.previous ? (
          <div style={{ display: 'flex', marginTop: 12, fontSize: 17, color: MUTED }}>
            {`Compared with last week: emails ${pct(t.emails, a.previous.emails)}, people ${pct(t.people, a.previous.people)}, replies ${pct(a.inboxTotal.received, a.previous.replies)}`}
          </div>
        ) : null}

        {segments.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 12 }}>
            {segments.map((s) => (
              <div key={s.label} style={{ display: 'flex', fontSize: 17, color: MUTED, height: 26 }}>
                {`${s.label}: ${num(s.emails)} emails, ${num(s.people)} people, ${num(s.replies)} replies`}
              </div>
            ))}
          </div>
        ) : null}

        {users.length ? (
          <Panel title="By user">
            <Row widths={uW} bold cells={[{ text: 'Name', color: MUTED }, { text: 'Emails', color: MUTED }, { text: 'People', color: MUTED }, { text: "From others' mailboxes", color: MUTED }, { text: 'Replies', color: MUTED }, { text: 'Failed', color: MUTED }]} />
            {users.map((u) => (
              <Row key={u.name} widths={uW} cells={[u.name, num(u.emails), num(u.people), num(u.fromOthersMailboxes ?? 0), num(u.replies ?? 0), u.failed ? { text: num(u.failed), color: RED } : '0']} />
            ))}
          </Panel>
        ) : null}

        {launchers.length ? (
          <Panel title="Who used whose mailbox">
            <Row widths={lW} bold cells={[{ text: 'Sent by', color: MUTED }, { text: 'Mailboxes used', color: MUTED }, { text: 'Emails', color: MUTED }]} />
            {launchers.map((g) => (
              <Row key={g.name} widths={lW} cells={[g.name, num(g.mailboxes), num(g.emails)]} />
            ))}
          </Panel>
        ) : null}

        {inbox.length ? (
          <Panel title="Inbox by person">
            <Row widths={iW} bold cells={[{ text: 'Name', color: MUTED }, { text: 'Received', color: MUTED }, { text: 'Pending', color: MUTED }, { text: 'Closed', color: MUTED }, { text: 'First reply', color: MUTED }, { text: 'Avg reply', color: MUTED }]} />
            {inbox.map((r) => (
              <Row key={r.name} widths={iW} cells={[r.name, num(r.received), r.pending ? { text: num(r.pending), color: RED } : '0', num(r.closed), duration(r.frtDay), duration(r.artDay)]} />
            ))}
            <Row widths={iW} bold cells={['Total', num(a.inboxTotal.received), num(a.inboxTotal.pending), num(a.inboxTotal.closed), duration(a.inboxTotal.frtDay), duration(a.inboxTotal.artDay)]} />
          </Panel>
        ) : null}

        <Panel title="Needs attention">
          {open.length ? (
            open.map(([label, n]) => (
              <div key={label} style={{ display: 'flex', fontSize: 19, height: 30, alignItems: 'center', color: RED, fontWeight: 600 }}>{`${n}  ${label}`}</div>
            ))
          ) : (
            <div style={{ display: 'flex', fontSize: 19, height: 30, alignItems: 'center', color: GREEN, fontWeight: 600 }}>Nothing needs attention: every reply answered, nothing past its SLA, nothing waiting for approval.</div>
          )}
        </Panel>
      </div>
    ),
    { width: W, height },
  );
  return { bytes: new Uint8Array(await res.arrayBuffer()), width: W, height };
}
