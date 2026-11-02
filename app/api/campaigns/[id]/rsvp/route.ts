import { NextResponse } from 'next/server';
import { EmailJobStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadCampaignForSession } from '@/lib/campaigns/context';
import { defaultRsvpConfig, rsvpConfigSchema, type RsvpConfig } from '@/lib/rsvp/config';

/**
 * A campaign's RSVP buttons: settings (GET/PUT) and answers (GET, or ?format=csv to download).
 * Once emails have gone out, answer options can be relabelled and recoloured but not removed
 * or re-keyed: the buttons already in people's inboxes point at those keys.
 */
export const dynamic = 'force-dynamic';

function storedConfig(value: unknown): RsvpConfig | null {
  const parsed = rsvpConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const config = storedConfig(campaign.rsvp);

  if (new URL(req.url).searchParams.get('format') === 'csv') {
    const rows = await prisma.rsvpResponse.findMany({
      where: { campaignId: campaign.id },
      orderBy: { respondedAt: 'asc' },
      select: { email: true, answer: true, note: true, respondedAt: true, updatedAt: true, changes: true },
    });
    const label = new Map((config?.options ?? []).map((o) => [o.key, o.label]));
    const lines = [
      ['Email', 'Answer', 'Note', 'First answered', 'Last changed', 'Times changed'].join(','),
      ...rows.map((r) => [r.email, label.get(r.answer) ?? r.answer, r.note, r.respondedAt.toISOString(), r.updatedAt.toISOString(), r.changes].map(csvCell).join(',')),
    ];
    return new NextResponse(lines.join('\r\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="rsvp-${campaign.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv"`,
      },
    });
  }

  const [counts, sent, responses, columns] = await Promise.all([
    prisma.rsvpResponse.groupBy({ by: ['answer'], where: { campaignId: campaign.id }, _count: { _all: true } }),
    prisma.emailJob.count({ where: { campaignId: campaign.id, status: EmailJobStatus.SENT } }),
    prisma.rsvpResponse.findMany({
      where: { campaignId: campaign.id },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: { email: true, answer: true, note: true, respondedAt: true, updatedAt: true, changes: true },
    }),
    prisma.datasetColumn.findMany({ where: { datasetId: campaign.datasetId }, orderBy: { order: 'asc' }, select: { key: true, label: true } }),
  ]);
  const answered = counts.reduce((n, c) => n + c._count._all, 0);

  return NextResponse.json({
    config: config ?? { ...defaultRsvpConfig(), enabled: false },
    lockedKeys: sent > 0 ? (config?.options ?? []).map((o) => o.key) : [],
    results: {
      sent,
      answered,
      notAnswered: Math.max(0, sent - answered),
      byAnswer: Object.fromEntries(counts.map((c) => [c.answer, c._count._all])),
      responses,
    },
    columns,
  });
});

export const PUT = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const parsed = rsvpConfigSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ error: `RSVP settings: ${first?.path.join('.') || 'value'} — ${first?.message ?? 'invalid'}` }, { status: 400 });
  }
  const next = parsed.data;
  const keys = next.options.map((o) => o.key);
  if (new Set(keys).size !== keys.length) return NextResponse.json({ error: 'Each answer needs its own key.' }, { status: 400 });

  // Buttons already sent point at these keys: they must survive.
  const previous = storedConfig(campaign.rsvp);
  const sent = await prisma.emailJob.count({ where: { campaignId: campaign.id, status: EmailJobStatus.SENT } });
  if (sent > 0 && previous) {
    const missing = previous.options.filter((o) => !keys.includes(o.key));
    if (missing.length) {
      return NextResponse.json(
        { error: `Emails with these buttons have already gone out, so "${missing.map((o) => o.label).join('", "')}" can't be removed. You can still change its text and colours.` },
        { status: 400 },
      );
    }
  }

  await prisma.campaign.update({ where: { id: campaign.id }, data: { rsvp: next as unknown as Prisma.InputJsonValue } });
  await audit(session, 'CAMPAIGN_RSVP_UPDATE', { targetType: 'Campaign', targetId: campaign.id, metadata: { enabled: next.enabled, options: keys } });
  return NextResponse.json({ ok: true, config: next });
});
