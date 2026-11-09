/**
 * A From / To date range from a filter, in India time. "To 2026-11-09" means the whole of 9 Nov
 * (up to, not including, 10 Nov 00:00 IST); before this, `lte: new Date('2026-11-09')` stopped
 * at 9 Nov 05:30 IST, so "last 7 days" left out today. Full timestamps are used as given.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function istDayStart(value: string): Date {
  return DAY.test(value) ? new Date(`${value}T00:00:00+05:30`) : new Date(value);
}

/** The instant just after the To day (use with `lt`). */
export function istDayEndExclusive(value: string): Date {
  if (!DAY.test(value)) return new Date(value);
  return new Date(istDayStart(value).getTime() + 86_400_000);
}

/** { gte, lt } for a Prisma date filter; either side may be missing. Invalid dates are ignored. */
export function istRange(from?: string | null, to?: string | null): { gte?: Date; lt?: Date } {
  const out: { gte?: Date; lt?: Date } = {};
  if (from) {
    const d = istDayStart(from);
    if (!Number.isNaN(d.getTime())) out.gte = d;
  }
  if (to) {
    const d = istDayEndExclusive(to);
    if (!Number.isNaN(d.getTime())) out.lt = d;
  }
  return out;
}

/** Today's (or a date's) calendar day in India, YYYY-MM-DD, for date pickers and presets. */
export function istYmd(d: Date = new Date()): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
