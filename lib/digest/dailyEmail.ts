import { appBaseUrl } from '@/lib/app-url';
import { escapeHtml } from '@/lib/templates/variables';
import type { LedgerSource } from '@/lib/analytics/sendLedger';
import { digestTotal, type DigestItem, type NeedsAttention } from '@/lib/digest/needsAttention';
import { SOURCE_COLOR, SOURCE_LABEL, type DailyActivity } from '@/lib/digest/dailyActivity';

/**
 * The daily email, laid out like the portal's Organization page (white cards on a light grey
 * page, Masai red, Outfit): yesterday's numbers, by type, by user, who used whose mailbox,
 * each person's inbox (received, pending, closed, FRT / ART), then what needs attention.
 * Built from tables with inline styles so Gmail and Outlook keep the look; the cards fade in
 * where the mail app supports animation (Apple Mail, iOS) and simply appear elsewhere.
 */

const INK = '#18181b';
const MUTED = '#71717a';
const FAINT = '#a1a1aa';
const LINE = '#ececf0';
const PAGE = '#f1f1f4';
const RED = '#ED0331';
const FONT = `'Outfit','Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const ICON: Record<LedgerSource, string> = { CAMPAIGN: '📣', QUICK_SEND: '⚡', RECRUITER: '✈️', INBOX_REPLY: '💬' };
const PASTEL = ['#fde2e4', '#e0f2fe', '#ede9fe', '#dcfce7', '#ffedd5', '#fae8ff', '#e0e7ff', '#ccfbf1'];
const PASTEL_INK = ['#be123c', '#0369a1', '#6d28d9', '#15803d', '#c2410c', '#a21caf', '#4338ca', '#0f766e'];

const num = (n: number) => n.toLocaleString('en-IN');
const e = (s: string) => escapeHtml(s);

/** 42 → "42m", 190 → "3h 10m", 3000 → "2d 2h". */
export function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const d = Math.floor(m / 1440);
  const h = Math.round((m % 1440) / 60);
  return `${d}d${h ? ` ${h}h` : ''}`;
}

function avatar(name: string, image: string | null, size = 30): string {
  if (image && /^https:\/\//.test(image)) {
    return `<img src="${e(image)}" width="${size}" height="${size}" alt="" style="display:block;width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;border:0">`;
  }
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  const i = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PASTEL.length;
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${PASTEL[i]};color:${PASTEL_INK[i]};font:600 ${Math.round(size * 0.37)}px/${size}px ${FONT};text-align:center">${e(initials)}</div>`;
}

function card(inner: string, opts: { pad?: number; delay?: number } = {}): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mf-rise" style="animation-delay:${opts.delay ?? 0}ms;background:#ffffff;border:1px solid ${LINE};border-radius:16px;border-collapse:separate;margin:0 0 14px">
<tr><td style="padding:${opts.pad ?? 18}px">${inner}</td></tr></table>`;
}

function cardTitle(icon: string, title: string, hint?: string): string {
  return `<div style="font:600 15px/1.3 ${FONT};color:${INK};margin:0 0 ${hint ? 2 : 12}px">${icon} &nbsp;${e(title)}</div>${hint ? `<div style="font:400 12px/1.4 ${FONT};color:${MUTED};margin:0 0 12px">${e(hint)}</div>` : ''}`;
}

/** A grid of KPI tiles, three per row. */
function tiles(items: { value: string; label: string; sub?: string; accent?: string }[]): string {
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 3) {
    const cells = items.slice(i, i + 3).map(
      (t) => `<td width="33.33%" valign="top" style="padding:5px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${LINE};border-radius:14px;border-collapse:separate"><tr><td style="padding:14px 16px">
<div style="font:700 26px/1.1 ${FONT};color:${t.accent ?? INK};letter-spacing:-0.5px">${t.value}</div>
<div style="font:500 13px/1.3 ${FONT};color:${INK};margin-top:6px">${e(t.label)}</div>
${t.sub ? `<div style="font:400 11px/1.3 ${FONT};color:${MUTED};margin-top:2px">${e(t.sub)}</div>` : ''}
</td></tr></table></td>`,
    );
    while (cells.length < 3) cells.push('<td width="33.33%" style="padding:5px"></td>');
    rows.push(`<tr>${cells.join('')}</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mf-rise" style="margin:0 0 9px">${rows.join('')}</table>`;
}

function typeCards(a: DailyActivity): string {
  if (!a.bySource.length) return '';
  const cells = a.bySource.map(
    (s) => `<td valign="top" style="padding:5px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${LINE};border-radius:14px;border-collapse:separate"><tr>
<td width="44" valign="top" style="padding:14px 0 14px 14px"><div style="width:38px;height:38px;border-radius:11px;background:${SOURCE_COLOR[s.source]};text-align:center;font:18px/38px ${FONT}">${ICON[s.source]}</div></td>
<td valign="top" style="padding:13px 14px 13px 10px">
<div style="font:600 14px/1.3 ${FONT};color:${INK}">${e(SOURCE_LABEL[s.source])}</div>
<div style="font:400 12px/1.4 ${FONT};color:${MUTED}"><b style="color:${INK}">${num(s.emails)}</b> email${s.emails === 1 ? '' : 's'} · <b style="color:${INK}">${num(s.people)}</b> people</div>
${s.borrowed ? `<div style="font:400 11px/1.4 ${FONT};color:${FAINT}">${num(s.borrowed)} from others' mailboxes</div>` : ''}
${s.failed ? `<div style="font:500 11px/1.4 ${FONT};color:${RED}">${num(s.failed)} failed</div>` : ''}
</td></tr></table></td>`,
  );
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>${cells.slice(i, i + 2).join('')}${cells.length - i === 1 ? '<td width="50%"></td>' : ''}</tr>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mf-rise" style="animation-delay:80ms;margin:0 0 9px">${rows.join('')}</table>`;
}

const TH = `font:600 10px/1.2 ${FONT};color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;padding:8px 8px;border-bottom:1px solid ${LINE}`;
const TD = `font:400 13px/1.3 ${FONT};color:${INK};padding:9px 8px;border-bottom:1px solid ${LINE}`;
const zeroDim = (n: number, bold = false) => (n ? `<span style="${bold ? 'font-weight:600;' : ''}color:${INK}">${num(n)}</span>` : `<span style="color:${FAINT}">0</span>`);

function typeBar(bySource: Record<LedgerSource, number>, total: number): string {
  if (!total) return `<div style="height:7px;border-radius:4px;background:${LINE}"></div>`;
  const parts = (Object.keys(SOURCE_COLOR) as LedgerSource[]).filter((k) => bySource[k] > 0);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:4px;overflow:hidden;border-collapse:collapse"><tr>${parts
    .map((k) => `<td width="${Math.max(4, Math.round((bySource[k] / total) * 100))}%" title="${e(SOURCE_LABEL[k])}: ${bySource[k]}" style="height:7px;background:${SOURCE_COLOR[k]};font-size:0;line-height:0">&nbsp;</td>`)
    .join('')}</tr></table>`;
}

function byUser(a: DailyActivity): string {
  // Only people who sent something; people whose mailbox was borrowed are in "Who used whose mailbox".
  const users = a.users.filter((u) => u.emails > 0 || u.failed > 0);
  if (!users.length) return '';
  type U = (typeof users)[number];
  const cols: { key: string; label: string; value: (u: U) => number; bold?: boolean; hideSm?: boolean }[] = [
    { key: 'emails', label: 'Emails', value: (u) => u.emails, bold: true },
    { key: 'people', label: 'People', value: (u) => u.people },
    { key: 'failed', label: 'Failed', value: (u) => u.failed },
    { key: 'own', label: 'Own mailbox', value: (u) => u.fromOwnMailbox, hideSm: true },
    { key: 'others', label: "Others' mailboxes", value: (u) => u.fromOthersMailboxes },
    { key: 'theirs', label: 'Theirs used', value: (u) => u.othersUsedTheirMailbox, hideSm: true },
    { key: 'replies', label: 'Replies', value: (u) => u.replies },
  ];
  // A column that is 0 for everyone says nothing: left out.
  const shown = cols.filter((c) => c.key === 'emails' || users.some((u) => c.value(u) > 0));
  const head = shown.map((c) => `<th align="right" class="${c.hideSm ? 'mf-hide-sm' : ''}" style="${TH}">${e(c.label)}</th>`).join('');
  const rows = users
    .map(
      (u) => `<tr>
<td style="${TD}"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:9px">${avatar(u.name, u.image)}</td><td><div style="font:500 13px/1.25 ${FONT};color:${INK}">${e(u.name)}</div>${u.workspace ? `<div class="mf-hide-sm" style="font:400 11px/1.3 ${FONT};color:${MUTED}">${e(u.workspace)}</div>` : ''}</td></tr></table></td>
<td class="mf-hide-sm" style="${TD};width:90px">${typeBar(u.bySource, u.emails)}</td>
${shown.map((c) => `<td align="right" class="${c.hideSm ? 'mf-hide-sm' : ''}" style="${TD}">${c.key === 'failed' && c.value(u) ? `<span style="font-weight:600;color:${RED}">${num(c.value(u))}</span>` : zeroDim(c.value(u), c.bold)}</td>`).join('')}
</tr>`,
    )
    .join('');
  return card(
    `${cardTitle('👥', 'By user', 'Who sent what on the day (people with nothing sent are left out).')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mf-t" style="border-collapse:collapse">
<tr><th align="left" style="${TH}">User</th><th align="left" class="mf-hide-sm" style="${TH}">By type</th>${head}</tr>
${rows}</table>`,
    { pad: 14, delay: 120 },
  );
}

/** In brief: one line per person who borrowed mailboxes, with each mailbox's numbers. */
function whoUsedWhose(a: DailyActivity): string {
  if (!a.pairs.length) return '';
  const byLauncher = new Map<string, { name: string; emails: number; people: number; items: typeof a.pairs }>();
  for (const p of a.pairs) {
    const g = byLauncher.get(p.launchedBy) ?? { name: p.launchedByName, emails: 0, people: 0, items: [] };
    g.emails += p.emails;
    g.people += p.people;
    g.items.push(p);
    byLauncher.set(p.launchedBy, g);
  }
  const chip = (p: (typeof a.pairs)[number]) =>
    `<span style="display:inline-block;margin:0 5px 6px 0;padding:4px 9px;border-radius:999px;background:#f4f4f5;border:1px solid ${LINE};font:400 12px/1.3 ${FONT};color:${INK};white-space:nowrap">${e((p.ownerName || p.mailbox).split(' ')[0]!)} <b>${num(p.emails)}</b><span style="color:${MUTED}"> · ${num(p.people)}</span></span>`;
  const blocks = [...byLauncher.values()]
    .sort((x, y) => y.emails - x.emails)
    .map(
      (g) => `<div style="padding:10px 0;border-top:1px solid ${LINE}">
<div style="font:500 13px/1.4 ${FONT};color:${INK};margin-bottom:7px">${e(g.name)} <span style="color:${MUTED};font-weight:400">used ${g.items.length} mailbox${g.items.length === 1 ? '' : 'es'} · <b style="color:${INK}">${num(g.emails)}</b> emails · <b style="color:${INK}">${num(g.people)}</b> people</span></div>
<div>${g.items.map(chip).join('')}</div></div>`,
    )
    .join('');
  return card(`${cardTitle('🔀', 'Who used whose mailbox', 'Mailbox owner · emails · people')}${blocks}`, { pad: 14, delay: 160 });
}

function inbox(a: DailyActivity): string {
  if (!a.inbox.length) return '';
  const t = a.inboxTotal;
  const time = (day: number | null, month: number | null) =>
    `<span style="font-weight:600;color:${day === null ? FAINT : INK}">${duration(day)}</span><div style="font:400 10px/1.3 ${FONT};color:${FAINT}">30d ${duration(month)}</div>`;
  const rows = a.inbox
    .map(
      (r) => `<tr>
<td style="${TD}"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:9px">${avatar(r.name, r.image, 26)}</td><td style="font:500 13px/1.25 ${FONT};color:${r.userId ? INK : MUTED}">${e(r.name)}</td></tr></table></td>
<td align="right" style="${TD}">${zeroDim(r.received, true)}</td>
<td align="right" style="${TD}">${r.pending ? `<span style="font-weight:600;color:${RED}">${num(r.pending)}</span>` : zeroDim(0)}</td>
<td align="right" style="${TD}">${zeroDim(r.closed)}</td>
<td align="right" style="${TD}">${time(r.frtDay, r.frt30)}</td>
<td align="right" style="${TD}">${time(r.artDay, r.art30)}</td>
</tr>`,
    )
    .join('');
  const total = `<tr style="background:#fafafa">
<td style="${TD};font-weight:700">Total</td>
<td align="right" style="${TD};font-weight:700">${num(t.received)}</td>
<td align="right" style="${TD};font-weight:700;color:${t.pending ? RED : INK}">${num(t.pending)}</td>
<td align="right" style="${TD};font-weight:700">${num(t.closed)}</td>
<td align="right" style="${TD}">${time(t.frtDay, t.frt30)}</td>
<td align="right" style="${TD}">${time(t.artDay, t.art30)}</td></tr>`;
  return card(
    `${cardTitle('📥', 'Inbox by person', 'Replies received and closed on the day; pending = waiting for an answer now. FRT = first response time, ART = average response time (day, and last 30 days below).')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mf-t" style="border-collapse:collapse">
<tr><th align="left" style="${TH}">Person</th><th align="right" style="${TH}">Received</th><th align="right" style="${TH}">Pending</th><th align="right" style="${TH}">Closed</th><th align="right" style="${TH}">FRT</th><th align="right" style="${TH}">ART</th></tr>
${rows}${total}</table>`,
    { pad: 14, delay: 200 },
  );
}

function attentionRows(items: DigestItem[]): string {
  return items
    .slice(0, 12)
    .map((i) => `<tr><td style="${TD}"><a href="${e(i.href)}" style="color:${INK};text-decoration:none;font-weight:500">${e(i.title)}</a><div style="font:400 11px/1.4 ${FONT};color:${MUTED}">${e(i.detail)}${i.workspace ? ` · ${e(i.workspace)}` : ''}</div></td></tr>`)
    .join('');
}

function attention(d: NeedsAttention): string {
  const base = appBaseUrl();
  const sections: [string, DigestItem[], string][] = [
    ['Replies waiting for an answer', d.unansweredReplies, `${base}/inbox`],
    ['Conversations past their SLA', d.slaBreaches, `${base}/inbox`],
    ['Documents expiring unsigned', d.expiringDocuments, `${base}/documents`],
    ['Campaigns waiting for approval', d.pendingCampaigns, `${base}/approvals`],
    ['New users waiting for approval', d.pendingUsers, `${base}/approvals?section=users`],
  ];
  const open = sections.filter(([, items]) => items.length);
  if (!open.length) return card(`<div style="font:500 14px/1.4 ${FONT};color:#059669">✓ &nbsp;Nothing needs attention: every reply answered, nothing past its SLA, nothing waiting for approval.</div>`, { delay: 240 });
  return open
    .map(([title, items, href], i) =>
      card(
        `<div style="font:600 15px/1.3 ${FONT};color:${INK};margin:0 0 6px">${e(title)} <span style="display:inline-block;margin-left:4px;padding:1px 8px;border-radius:999px;background:#fde2e4;color:${RED};font-size:12px">${items.length}</span></div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mf-t" style="border-collapse:collapse">${attentionRows(items)}</table>
<div style="margin-top:8px"><a href="${e(href)}" style="font:500 12px/1.4 ${FONT};color:${RED};text-decoration:none">Open →</a></div>`,
        { pad: 14, delay: 240 + i * 40 },
      ),
    )
    .join('');
}

export function dailyLabel(a: { from: Date }): string {
  return a.from.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
}

export function renderDailyEmail(a: DailyActivity, d: NeedsAttention): { subject: string; html: string } {
  const base = appBaseUrl();
  const t = a.totals;
  const items = digestTotal(d);
  const day = dailyLabel(a);
  const dashboard = `${base}/admin/organization?lfrom=${a.ymd}&lto=${a.ymd}`;

  const kpis = tiles([
    { value: num(t.emails), label: 'Emails sent', sub: `${num(t.mailboxes)} mailbox${t.mailboxes === 1 ? '' : 'es'}` },
    { value: num(t.people), label: 'People reached', sub: 'To + Cc + Bcc' },
    { value: num(t.failed), label: 'Failed', accent: t.failed ? RED : INK },
    { value: num(t.borrowed), label: "From others' mailboxes", sub: 'backup / teammates' },
    { value: num(a.inboxTotal.received), label: 'Replies received', sub: t.replyRate !== null ? `${t.replyRate}% of emails` : undefined },
    { value: num(a.inboxTotal.pending), label: 'Waiting for an answer', sub: `${num(a.inboxTotal.closed)} closed on the day`, accent: a.inboxTotal.pending ? RED : INK },
  ]);

  const body = `
<div style="font:600 11px/1.2 ${FONT};letter-spacing:1.4px;text-transform:uppercase;color:${RED};margin:0 0 10px">Yesterday · ${e(day)}</div>
${kpis}
${typeCards(a)}
${byUser(a)}
${whoUsedWhose(a)}
${inbox(a)}
<div style="font:600 11px/1.2 ${FONT};letter-spacing:1.4px;text-transform:uppercase;color:${RED};margin:22px 0 10px">Needs attention today</div>
${attention(d)}`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
@keyframes mfRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.mf-rise{animation:mfRise .5s cubic-bezier(.2,.7,.2,1) both}
@media (max-width:600px){.mf-wrap{padding:14px 8px!important}.mf-hide-sm{display:none!important}.mf-t>tbody>tr>td,.mf-t>tbody>tr>th{padding-left:4px!important;padding-right:4px!important}}
</style></head>
<body style="margin:0;padding:0;background:${PAGE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE}"><tr><td align="center" class="mf-wrap" style="padding:28px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px"><tr><td>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mf-rise" style="background:${INK};background-image:linear-gradient(135deg,#18181b 0%,#18181b 55%,#7f0119 100%);border-radius:18px;border-collapse:separate;margin:0 0 14px"><tr>
<td style="padding:22px 24px">
<div style="font:600 11px/1.2 ${FONT};letter-spacing:1.6px;text-transform:uppercase;color:#fda4af">MailFlow · Daily report</div>
<div style="font:700 24px/1.25 ${FONT};color:#ffffff;margin-top:6px">${num(t.emails)} emails · ${num(t.people)} people · ${num(a.inboxTotal.received)} replies</div>
<div style="font:400 13px/1.4 ${FONT};color:#d4d4d8;margin-top:4px">${e(day)}${items ? ` · ${items} thing${items === 1 ? '' : 's'} need attention today` : ' · nothing needs attention'}</div>
<div style="margin-top:14px"><a href="${e(dashboard)}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:${RED};color:#ffffff;font:600 13px/1 ${FONT};text-decoration:none">Open live dashboard →</a></div>
</td>
</tr></table>
${body}
<div style="font:400 11px/1.5 ${FONT};color:${FAINT};text-align:center;margin-top:18px">Sent by MailFlow at 9:00 IST · the live, filterable view is under Super Admin → Organization · change these emails under System Settings</div>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const subject = `[MailFlow] ${day}: ${num(t.emails)} emails, ${num(a.inboxTotal.received)} replies${items ? ` · ${items} need attention` : ''}`;
  return { subject, html };
}

export function renderDailySlackLine(a: DailyActivity): string {
  const t = a.totals;
  return `:bar_chart: *Yesterday (${dailyLabel(a)})*: ${num(t.emails)} emails to ${num(t.people)} people${t.failed ? `, ${t.failed} failed` : ''}; ${num(a.inboxTotal.received)} replies received, ${num(a.inboxTotal.pending)} waiting, ${num(a.inboxTotal.closed)} closed · FRT ${duration(a.inboxTotal.frtDay)}, ART ${duration(a.inboxTotal.artDay)}`;
}
