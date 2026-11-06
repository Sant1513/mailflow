import { NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { LEDGER_SOURCES, ledgerOptions, ledgerReport, type LedgerSource } from '@/lib/analytics/sendLedger';
import { dailyLimit, usageLast24h } from '@/lib/queue/drain';

/**
 * Super Admin → Organization → "Everything sent": every email from every workspace, by type,
 * user and mailbox (lib/analytics/sendLedger.ts), with the filters in the query string:
 *   days=7|30|90 or from=YYYY-MM-DD&to=YYYY-MM-DD (IST days, inclusive)
 *   workspace=, user=, mailbox=, type= (comma-separated), status=SENT|FAILED, borrowed=1
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50) : undefined);
// IST midnight of a YYYY-MM-DD date, as a UTC instant.
const istDay = (d: string) => new Date(`${d}T00:00:00+05:30`);

export const GET = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const q = new URL(req.url).searchParams;
  const fromQ = q.get('from');
  const toQ = q.get('to');
  let from: Date;
  let to: Date;
  if (fromQ && toQ && /^\d{4}-\d{2}-\d{2}$/.test(fromQ) && /^\d{4}-\d{2}-\d{2}$/.test(toQ)) {
    from = istDay(fromQ);
    to = new Date(istDay(toQ).getTime() + 864e5);
  } else {
    const days = [7, 30, 90, 365].includes(Number(q.get('days'))) ? Number(q.get('days')) : 30;
    to = new Date();
    from = new Date(to.getTime() - days * 864e5);
  }
  const types = list(q.get('type'))?.filter((t): t is LedgerSource => (LEDGER_SOURCES as string[]).includes(t));
  const status = q.get('status') === 'SENT' || q.get('status') === 'FAILED' ? (q.get('status') as 'SENT' | 'FAILED') : 'ALL';

  const [report, options] = await Promise.all([
    ledgerReport({
      organizationId: session.organizationId,
      from,
      to,
      workspaceIds: list(q.get('workspace')),
      userIds: list(q.get('user')),
      accountIds: list(q.get('mailbox')),
      sources: types,
      status,
      borrowedOnly: q.get('borrowed') === '1',
    }),
    ledgerOptions(session.organizationId),
  ]);
  // Today's use of each mailbox in the table, against Google's daily limit.
  const usage = await Promise.all(report.byMailbox.slice(0, 40).map(async (m) => ({ id: m.accountId, last24h: (await usageLast24h(m.accountId)).messages })));
  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    report: { ...report, byMailbox: report.byMailbox.map((m) => ({ ...m, last24h: usage.find((u) => u.id === m.accountId)?.last24h ?? null, dailyLimit: dailyLimit() })) },
    options,
  });
});
