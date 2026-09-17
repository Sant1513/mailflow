import { requireSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';

function csvCell(value: string | number | null | undefined): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const workspaceId = session.workspaceId;

    if (!workspaceId) {
      return new Response(JSON.stringify({ error: 'No workspace attached.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(req.url);
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')!) : defaultFrom;
    const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : now;
    const statusFilter = url.searchParams.get('status') ?? undefined;

    const where: Record<string, unknown> = {
      workspaceId,
      sentAt: { gte: from, lte: to },
    };
    if (statusFilter) {
      where.status = statusFilter;
    }

    const requests = await prisma.signingRequest.findMany({
      where,
      orderBy: { sentAt: 'desc' },
      select: {
        id: true,
        title: true,
        recipientName: true,
        recipientEmail: true,
        status: true,
        sentAt: true,
        signedAt: true,
        reminderCount: true,
      },
    });

    const rows: string[][] = [
      ['ID', 'Title', 'Recipient Name', 'Recipient Email', 'Status', 'Sent At', 'Signed At', 'Hours to Sign', 'Reminders'],
      ...requests.map((r) => {
        const hoursToSign =
          r.signedAt && r.sentAt
            ? String(Math.round((r.signedAt.getTime() - r.sentAt.getTime()) / (1000 * 60 * 60)))
            : '';
        return [
          r.id,
          r.title,
          r.recipientName,
          r.recipientEmail,
          r.status,
          r.sentAt ? r.sentAt.toISOString() : '',
          r.signedAt ? r.signedAt.toISOString() : '',
          hoursToSign,
          String(r.reminderCount),
        ];
      }),
    ];

    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
    const dateStr = now.toISOString().slice(0, 10);

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="signing-report-${dateStr}.csv"`,
      },
    });
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? 500;
    const message = err instanceof Error ? err.message : 'Internal error';
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
