import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { pageInfo, parsePaging } from '@/lib/api/paging';
import { requireCanWrite, resolveWorkspaceId } from '@/lib/permissions/workspace';
import { csvFileName, csvResponse, toCsv, type CsvValue } from '@/lib/export/csv';
import { CATEGORY_LABEL, isBounceCategory } from '@/lib/email/dsn';
import { orgWorkspaceIds, SHARED_REASONS, visibleToWorkspace } from '@/lib/suppressions/scope';
import { isOrgCopy, parseSuppressionFilters, suppressionOrderBy, suppressionWhere } from '@/lib/suppressions/filters';

export const dynamic = 'force-dynamic';

/** Most rows one CSV download carries. */
const CSV_MAX = 50_000;

const SELECT = {
  id: true,
  workspaceId: true,
  email: true,
  reason: true,
  source: true,
  detail: true,
  category: true,
  statusCode: true,
  remark: true,
  recruiterBlastId: true,
  createdAt: true,
  addedBy: { select: { name: true, email: true } },
  campaign: { select: { id: true, name: true } },
  workspace: { select: { owner: { select: { id: true, name: true } } } },
} as const;

const REASON_LABEL: Record<string, string> = { BOUNCED: 'Bounced', UNSUBSCRIBED: 'Unsubscribed', COMPLAINT: 'Marked as spam' };
const SOURCE_LABEL: Record<string, string> = { MANUAL: 'Manual', BOUNCE: 'Bounce', UNSUBSCRIBE: 'Unsubscribe', COMPLAINT: 'Complaint' };

/**
 * GET /api/suppressions — the workspace's suppression list, filtered on the server:
 *   q (email, remark, server message, code) · type · category · source · reason · scope (own|org)
 *   · from / to (YYYY-MM-DD, India time) · send (campaign:<id> | blast:<id>) · sort (newest|oldest|email)
 *   · page / pageSize. With format=csv: the whole filtered list as a CSV download.
 * The response also lists the sends that appear on the list (for the "send" filter).
 */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const filters = parseSuppressionFilters(url.searchParams);
  const visible = await visibleToWorkspace(workspaceId);
  const where = suppressionWhere(workspaceId, filters, visible);
  const orderBy = suppressionOrderBy(filters.sort);

  if (url.searchParams.get('format') === 'csv') {
    const rows = await prisma.emailSuppression.findMany({ where, orderBy, take: CSV_MAX, select: SELECT });
    const blasts = await blastNames(rows.map((r) => r.recruiterBlastId));
    const csv = toCsv(
      ['Email', 'Reason', 'Category', 'Remark', 'Status code', 'Server message / detail', 'Source', 'Org-wide copy', 'Campaign', 'Recruiter Bulk Send', 'Added by', 'Saved in workspace of', 'Added (IST)'],
      rows.map((r): CsvValue[] => [
        r.email,
        REASON_LABEL[r.reason] ?? r.reason,
        isBounceCategory(r.category) ? CATEGORY_LABEL[r.category] : (r.category ?? ''),
        r.remark,
        r.statusCode,
        r.detail,
        SOURCE_LABEL[r.source] ?? r.source,
        isOrgCopy(r.detail) || r.workspaceId !== workspaceId ? 'Yes' : '',
        r.campaign?.name ?? '',
        r.recruiterBlastId ? (blasts.get(r.recruiterBlastId) ?? r.recruiterBlastId) : '',
        r.addedBy ? `${r.addedBy.name ?? ''} <${r.addedBy.email}>` : '',
        r.workspace.owner.name,
        r.createdAt,
      ]),
    );
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    return csvResponse(csv, csvFileName(`Suppressions ${day}`, rows.length >= CSV_MAX ? `first ${CSV_MAX}` : `${rows.length} addresses`));
  }

  const paging = parsePaging(url.searchParams, { pageSize: 50 });
  const [suppressions, total, campaignIds, blastIds, perWorkspace] = await Promise.all([
    prisma.emailSuppression.findMany({ where, orderBy, skip: paging.skip, take: paging.take, select: SELECT }),
    prisma.emailSuppression.count({ where }),
    prisma.emailSuppression.groupBy({ by: ['campaignId'], where: { AND: [visible, { campaignId: { not: null } }] }, _count: { _all: true } }),
    prisma.emailSuppression.groupBy({ by: ['recruiterBlastId'], where: { AND: [visible, { recruiterBlastId: { not: null } }] }, _count: { _all: true } }),
    prisma.emailSuppression.groupBy({ by: ['workspaceId'], where: visible, _count: { _all: true } }),
  ]);
  // The "user" filter: whose workspace saved each entry (owner of the workspace), with how many.
  const ownerRows = perWorkspace.length
    ? await prisma.workspace.findMany({ where: { id: { in: perWorkspace.map((p) => p.workspaceId) } }, select: { id: true, owner: { select: { id: true, name: true, email: true } } } })
    : [];
  const byOwner = new Map<string, { value: string; label: string; count: number }>();
  for (const w of ownerRows) {
    const n = perWorkspace.find((p) => p.workspaceId === w.id)?._count._all ?? 0;
    const cur = byOwner.get(w.owner.id);
    if (cur) cur.count += n; else byOwner.set(w.owner.id, { value: w.owner.id, label: w.owner.name || w.owner.email, count: n });
  }
  const users = [...byOwner.values()].sort((a, b) => a.label.localeCompare(b.label));
  const [campaigns, blasts] = await Promise.all([
    campaignIds.length
      ? prisma.campaign.findMany({ where: { id: { in: campaignIds.map((c) => c.campaignId!).filter(Boolean) } }, select: { id: true, name: true } })
      : Promise.resolve([] as { id: string; name: string }[]),
    blastNames([...blastIds.map((b) => b.recruiterBlastId), ...suppressions.map((s) => s.recruiterBlastId)]),
  ]);
  const sends = [
    ...campaigns.map((c) => ({ value: `campaign:${c.id}`, label: `Campaign · ${c.name}`, count: campaignIds.find((x) => x.campaignId === c.id)?._count._all ?? 0 })),
    ...blastIds.filter((b) => b.recruiterBlastId).map((b) => ({ value: `blast:${b.recruiterBlastId}`, label: `Recruiter send · ${blasts.get(b.recruiterBlastId!) ?? 'deleted send'}`, count: b._count._all })),
  ].sort((a, b) => a.label.localeCompare(b.label));

  return NextResponse.json({
    suppressions: suppressions.map((s) => ({ ...s, recruiterBlast: s.recruiterBlastId ? { id: s.recruiterBlastId, name: blasts.get(s.recruiterBlastId) ?? null } : null, orgCopy: isOrgCopy(s.detail) || s.workspaceId !== workspaceId, savedBy: s.workspace.owner.name || null, workspace: undefined })),
    ...pageInfo(total, paging),
    // Kept for older clients.
    pageCount: Math.max(1, Math.ceil(total / paging.pageSize)),
    sends,
    users,
  });
});

async function blastNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await prisma.recruiterBlast.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

const PostSchema = z.object({
  email: z.string().email(),
  reason: z.enum(['UNSUBSCRIBED', 'BOUNCED', 'COMPLAINT']).default('UNSUBSCRIBED'),
  detail: z.string().optional(),
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  // Removing an unsubscribe re-enables email to someone who opted out: viewers and view-as can't.
  requireCanWrite(session);
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const body = PostSchema.parse(await req.json());

  const suppression = await prisma.emailSuppression.upsert({
    where: { workspaceId_email: { workspaceId, email: body.email.toLowerCase() } },
    create: {
      workspaceId,
      email: body.email.toLowerCase(),
      reason: body.reason,
      source: 'MANUAL',
      addedByUserId: session.userId,
      detail: body.detail ?? null,
    },
    update: {
      reason: body.reason,
      source: 'MANUAL',
      addedByUserId: session.userId,
      detail: body.detail ?? null,
    },
    select: { id: true, email: true, reason: true, source: true, detail: true, createdAt: true },
  });

  return NextResponse.json(suppression, { status: 201 });
});

export const DELETE = withErrorHandling(async (req) => {
  const session = await requireSession();
  // Removing an unsubscribe re-enables email to someone who opted out: viewers and view-as can't.
  requireCanWrite(session);
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  // A bounce or complaint is one shared entry for the organisation: removing it removes it for everyone (an unsubscribe is just this workspace's).
  const row = await prisma.emailSuppression.findFirst({ where: { AND: [await visibleToWorkspace(workspaceId), { id }] }, select: { id: true, email: true, reason: true } });
  if (row && (SHARED_REASONS as readonly string[]).includes(row.reason)) {
    const ids = await orgWorkspaceIds(workspaceId);
    await prisma.emailSuppression.deleteMany({ where: { workspaceId: { in: ids }, email: row.email, reason: { in: [...SHARED_REASONS] } } });
  } else {
    await prisma.emailSuppression.deleteMany({ where: { id, workspaceId } });
  }

  return NextResponse.json({ ok: true });
});
