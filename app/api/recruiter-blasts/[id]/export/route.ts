import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastReader } from '@/lib/recruiterSend/access';
import { audit } from '@/lib/audit/log';
import { FILTER_LABEL, csvFileName, csvResponse, parseOpenFilter, toCsv, type CsvValue } from '@/lib/export/csv';

/**
 * GET /api/recruiter-blasts/:id/export?filter=all|opened|not_opened → CSV of the send's
 * recruiters with sent / opened / replied, the mailbox that sent each, bounce or skip reasons,
 * and every column from the uploaded list (so UTM ids come along).
 *
 * Opens are per recruiter only for individual copies; a BCC email is one message for up to 250
 * people, so its opens can't be tied to a person and the opened / not-opened filters are refused.
 */
export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = { SENT: 'Sent', BOUNCED: 'Bounced', SKIPPED: 'Skipped', FAILED: 'Failed', QUEUED: 'Queued', PENDING: 'Not sent (draft)', CANCELLED: 'Cancelled' };

export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastReader();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const filter = parseOpenFilter(new URL(req.url).searchParams.get('filter'));
  const bcc = blast.mode === 'BCC';
  if (bcc && filter !== 'all') {
    return NextResponse.json({ error: 'A BCC email goes to many recruiters at once, so opens can’t be told apart per person. Download all recruiters instead.' }, { status: 400 });
  }

  const [recipients, groups] = await Promise.all([
    prisma.recruiterBlastRecipient.findMany({
      where: {
        blastId: blast.id,
        ...(filter === 'opened' ? { openedAt: { not: null } } : {}),
        ...(filter === 'not_opened' ? { status: 'SENT', openedAt: null } : {}),
      },
      select: { email: true, name: true, status: true, skipReason: true, groupId: true, sentAt: true, openedAt: true, openCount: true, repliedAt: true, data: true },
      orderBy: { email: 'asc' },
    }),
    prisma.recruiterBlastGroup.findMany({ where: { blastId: blast.id }, select: { id: true, fromEmail: true, openCount: true, error: true } }),
  ]);
  const groupById = new Map(groups.map((g) => [g.id, g]));

  // The uploaded list's own columns, minus the address column (already the first column).
  const columns = (blast.columns ?? []).filter((c) => c !== blast.emailColumn);
  const headers = [
    'Email',
    'Name',
    'Status',
    bcc ? 'Opened (BCC: not tracked per person)' : 'Opened',
    'First opened (IST)',
    bcc ? 'Opens of the shared BCC email' : 'Opens',
    'Replied',
    'Replied at (IST)',
    'Sent at (IST)',
    'Sent from',
    'Bounce / skip reason',
    ...columns,
  ];
  const rows: CsvValue[][] = recipients.map((r) => {
    const g = r.groupId ? groupById.get(r.groupId) : undefined;
    const data = (r.data ?? {}) as Record<string, unknown>;
    return [
      r.email,
      r.name ?? '',
      STATUS_LABEL[r.status] ?? r.status,
      bcc ? '' : r.openedAt ? 'Yes' : r.status === 'SENT' ? 'No' : '',
      bcc ? null : r.openedAt,
      bcc ? (g?.openCount ?? 0) : r.openCount,
      r.repliedAt ? 'Yes' : r.status === 'SENT' ? 'No' : '',
      r.repliedAt,
      r.sentAt,
      g?.fromEmail ?? '',
      r.skipReason ?? (r.status === 'FAILED' ? g?.error ?? '' : ''),
      ...columns.map((c) => (data[c] === undefined || data[c] === null ? '' : String(data[c]))),
    ];
  });

  await audit(session, 'RECRUITER_SEND_EXPORT', { targetType: 'RecruiterBlast', targetId: blast.id, metadata: { filter, rows: rows.length } }).catch(() => undefined);
  return csvResponse(toCsv(headers, rows), csvFileName(blast.name, `recruiters ${FILTER_LABEL[filter]}`));
});
