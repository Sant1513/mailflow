/**
 * Time left for a running Recruiter Bulk Send, worked out from how fast it is really going
 * (emails out in the last 10 minutes), not from the pause setting: mailbox limits, pauses and
 * the sender's own pace make a real send much slower than "pause × rounds".
 */

export const PACE_WINDOW_MIN = 10;

export interface EtaInput {
  /** Emails still to send (batches not yet sent). */
  remaining: number;
  /** Emails sent in the last PACE_WINDOW_MIN minutes. */
  sentLast10Min: number;
  /** Emails sent so far. */
  sentTotal: number;
  startedAt: Date | string | null;
  now?: Date;
}

export type EtaBasis = 'recent' | 'average' | 'done' | 'waiting' | 'calculating';

export interface Eta {
  /** Milliseconds left, or null when it can't be told. */
  ms: number | null;
  basis: EtaBasis;
  /** Emails per minute the estimate is based on. */
  ratePerMin: number | null;
}

export function estimateRemaining(input: EtaInput): Eta {
  const now = (input.now ?? new Date()).getTime();
  if (input.remaining <= 0) return { ms: 0, basis: 'done', ratePerMin: null };
  const started = input.startedAt ? new Date(input.startedAt).getTime() : null;
  const elapsedMin = started ? Math.max(0, (now - started) / 60_000) : 0;

  // Recent pace: the last 10 minutes (or since the start, when it began more recently than that).
  if (input.sentLast10Min >= 3) {
    const windowMin = Math.max(1, Math.min(PACE_WINDOW_MIN, elapsedMin || PACE_WINDOW_MIN));
    const rate = input.sentLast10Min / windowMin;
    return { ms: Math.round((input.remaining / rate) * 60_000), basis: 'recent', ratePerMin: rate };
  }
  // Nothing (or next to nothing) went out for 10 minutes: it is held up, e.g. waiting for a mailbox.
  if (elapsedMin > PACE_WINDOW_MIN) return { ms: null, basis: 'waiting', ratePerMin: null };
  // Just started: the average since the start, once there is a little to go on.
  if (input.sentTotal >= 3 && elapsedMin >= 1) {
    const rate = input.sentTotal / elapsedMin;
    return { ms: Math.round((input.remaining / rate) * 60_000), basis: 'average', ratePerMin: rate };
  }
  return { ms: null, basis: 'calculating', ratePerMin: null };
}

/** "1 h 52 min", "42 min", "35 s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

/** A ticking countdown: "1:52:10", "42:05". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const IST_SECONDS = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

/** "13 Nov 2026, 11:22 am" (India time). */
export function formatIst(d: Date | string | number | null | undefined): string {
  if (d === null || d === undefined) return '—';
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? '—' : IST.format(date);
}

/** "13 Nov, 11:22:32 am" (India time), for the per-email table. */
export function formatIstSeconds(d: Date | string | number | null | undefined): string {
  if (d === null || d === undefined) return '—';
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? '—' : IST_SECONDS.format(date);
}
