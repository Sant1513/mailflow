import { sortRows, type SortDir } from '@/lib/ui/sort';

/** Pure helpers for the campaign analytics page: who opened how many times, when, on what, and which links work. */

export interface OpenEvent { email: string; createdAt: Date; userAgent: string | null }
export interface ClickEvent { email: string; createdAt: Date; url: string | null; userAgent: string | null }

export type Device = 'Mobile' | 'Tablet' | 'Desktop' | 'Unknown';

export function deviceOf(ua: string | null | undefined): Device {
  if (!ua) return 'Unknown';
  if (/iPad|Tablet|Nexus 7|Nexus 9|SM-T\d/i.test(ua)) return 'Tablet';
  if (/Android.*Mobile|iPhone|iPod|Mobile|Windows Phone/i.test(ua)) return 'Mobile';
  if (/Android/i.test(ua)) return 'Tablet';
  if (/Windows NT|Macintosh|Mac OS X|X11|Linux|CrOS/i.test(ua)) return 'Desktop';
  return 'Unknown';
}

/** Mail program or proxy the open came through, as far as the user-agent tells. */
export function mailClientOf(ua: string | null | undefined): string {
  if (!ua) return 'Unknown';
  if (/GoogleImageProxy/i.test(ua)) return 'Gmail';
  if (/YahooMailProxy/i.test(ua)) return 'Yahoo Mail';
  if (/Outlook|Microsoft Office/i.test(ua)) return 'Outlook';
  if (/Thunderbird/i.test(ua)) return 'Thunderbird';
  if (/Apple ?Mail|AppleWebKit.*Mail/i.test(ua)) return 'Apple Mail';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  return 'Other';
}

export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

const IST_MS = 5.5 * 3600_000;
/** 24 counts: how many of the dates fall in each hour of the day, India time. */
export function hourBuckets(dates: Date[]): number[] {
  const out = new Array<number>(24).fill(0);
  for (const d of dates) out[new Date(d.getTime() + IST_MS).getUTCHours()]! += 1;
  return out;
}

export interface OpenerRow {
  email: string;
  opens: number;
  firstOpenedAt: Date;
  lastOpenedAt: Date;
  device: Device;
  client: string;
  /** Seconds from sending to the first open (null when the send time is unknown). */
  secondsToFirstOpen: number | null;
  clicks: number;
}

/** One row per person: how many times they opened, first/last open, device, speed, and how many links they clicked. */
export function summariseOpeners(opens: OpenEvent[], sentAt: Map<string, Date>, clicks: ClickEvent[] = []): OpenerRow[] {
  const clickCount = new Map<string, number>();
  for (const c of clicks) clickCount.set(c.email.toLowerCase(), (clickCount.get(c.email.toLowerCase()) ?? 0) + 1);
  const by = new Map<string, OpenEvent[]>();
  for (const e of opens) { const k = e.email.toLowerCase(); const l = by.get(k); l ? l.push(e) : by.set(k, [e]); }
  return [...by.entries()].map(([email, evs]) => {
    const sorted = [...evs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const first = sorted[0]!, last = sorted[sorted.length - 1]!;
    const sent = sentAt.get(email);
    const secs = sent ? Math.max(0, Math.round((first.createdAt.getTime() - sent.getTime()) / 1000)) : null;
    return { email, opens: sorted.length, firstOpenedAt: first.createdAt, lastOpenedAt: last.createdAt, device: deviceOf(first.userAgent), client: mailClientOf(first.userAgent), secondsToFirstOpen: secs, clicks: clickCount.get(email) ?? 0 };
  });
}

export interface ClickerRow { email: string; clicks: number; links: number; firstClickedAt: Date; lastClickedAt: Date; topUrl: string | null }

export function summariseClickers(clicks: ClickEvent[]): ClickerRow[] {
  const by = new Map<string, ClickEvent[]>();
  for (const e of clicks) { const k = e.email.toLowerCase(); const l = by.get(k); l ? l.push(e) : by.set(k, [e]); }
  return [...by.entries()].map(([email, evs]) => {
    const sorted = [...evs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const perUrl = new Map<string, number>();
    for (const e of evs) if (e.url) perUrl.set(e.url, (perUrl.get(e.url) ?? 0) + 1);
    const top = [...perUrl.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { email, clicks: evs.length, links: perUrl.size, firstClickedAt: sorted[0]!.createdAt, lastClickedAt: sorted[sorted.length - 1]!.createdAt, topUrl: top };
  });
}

export interface LinkRow { url: string; clicks: number; people: number }
/** Which links work: total clicks and distinct people per destination. */
export function topLinks(clicks: ClickEvent[], limit = 10): LinkRow[] {
  const by = new Map<string, { clicks: number; people: Set<string> }>();
  for (const c of clicks) {
    if (!c.url) continue;
    const e = by.get(c.url) ?? { clicks: 0, people: new Set<string>() };
    e.clicks += 1; e.people.add(c.email.toLowerCase()); by.set(c.url, e);
  }
  return [...by.entries()].map(([url, v]) => ({ url, clicks: v.clicks, people: v.people.size })).sort((a, b) => b.clicks - a.clicks || a.url.localeCompare(b.url)).slice(0, limit);
}

export function countBy<T>(items: T[], key: (t: T) => string): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

/** How quickly people open: share of openers whose first open came within 1 hour / 24 hours / later. */
export function speedBands(seconds: (number | null)[]): { within1h: number; within24h: number; later: number } {
  let a = 0, b = 0, c = 0;
  for (const s of seconds) { if (s === null) continue; if (s <= 3600) a++; else if (s <= 86400) b++; else c++; }
  return { within1h: a, within24h: b, later: c };
}

export const SORTS = {
  sent: ['toEmail', 'subject', 'sentAt'],
  failed: ['toEmail', 'errorCode', 'lastAttemptAt'],
  replied: ['recipientEmail', 'subject', 'status', 'createdAt'],
  read: ['email', 'opens', 'firstOpenedAt', 'lastOpenedAt', 'device', 'secondsToFirstOpen', 'clicks'],
  clicked: ['email', 'clicks', 'links', 'firstClickedAt', 'lastClickedAt'],
  unopened: ['email', 'sentAt'],
} as const;
export type AnalyticsTab = keyof typeof SORTS;

export function parseSort(tab: AnalyticsTab, key: string | null, dir: string | null): { key: string; dir: SortDir } {
  const allowed = SORTS[tab] as readonly string[];
  const DEFAULT: Record<AnalyticsTab, string> = { sent: 'sentAt', failed: 'lastAttemptAt', replied: 'createdAt', read: 'lastOpenedAt', clicked: 'lastClickedAt', unopened: 'sentAt' };
  const k = key && allowed.includes(key) ? key : DEFAULT[tab];
  const natural: SortDir = ['toEmail', 'recipientEmail', 'email', 'subject', 'errorCode', 'status', 'device'].includes(k) ? 'asc' : 'desc';
  return { key: k, dir: dir === 'asc' || dir === 'desc' ? dir : natural };
}

export function sortInMemory<T extends Record<string, unknown>>(rows: T[], key: string, dir: SortDir): T[] {
  return sortRows(rows, (r) => r[key], dir);
}
