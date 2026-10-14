import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CampaignStatus, ColumnType, Prisma, Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession, type AppSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { dryRun } from '@/lib/campaigns/evaluate';
import { renderTemplate, extractVariables, htmlToPlainText } from '@/lib/templates/variables';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';
import { linkContactsForDataset } from '@/lib/records/contactLink';
import { loadCampaignForSession, senderAccountFor } from '@/lib/campaigns/context';
import { startCampaignSend } from '@/lib/campaigns/startSend';
import { availableFallbackMailboxes, validateFallbackList } from '@/lib/campaigns/fallback';
import { sendApprovalRequestEmail } from '@/lib/campaigns/approvalEmails';
import { dailyLimit, usageLast24h } from '@/lib/queue/drain';
import { buildContactWhere } from '@/app/api/segments/_filterContacts';
import { columnsFromTable, normalizeVariables, textToHtml } from '@/lib/quickSend/prepare';
import { QUICK_SEND_DESCRIPTION, QUICK_SEND_ON_APPROVAL, campaignStats } from '@/lib/quickSend/stats';

export const maxDuration = 60;

const MAX_ROWS = 5000;

const emailList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(/[,;\n]/)).map((e) => e.trim()).filter(Boolean))
  .refine((l) => l.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)), { message: 'A Cc/Bcc address is not a valid email address.' })
  .refine((l) => l.length <= 25, { message: 'At most 25 Cc/Bcc addresses.' });

const recipientsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('table'),
    headers: z.array(z.string()).min(1).max(100),
    rows: z.array(z.record(z.string(), z.any())).min(1).max(MAX_ROWS),
    emailHeader: z.string().optional(),
  }),
  z.object({ kind: z.literal('dataset'), datasetId: z.string().min(1) }),
  z.object({ kind: z.literal('segment'), segmentId: z.string().min(1) }),
]);

const bodySchema = z.object({
  mode: z.enum(['check', 'send']),
  recipients: recipientsSchema,
  subject: z.string().trim().min(1, 'Add a subject.').max(500),
  body: z.string().min(1, 'Write the message.').max(200_000),
  format: z.enum(['text', 'html']).default('text'),
  fromName: z.string().max(200).optional(),
  replyTo: z.string().email('Reply-To must be a valid email address.').optional().or(z.literal('').transform(() => undefined)),
  cc: emailList.optional(),
  bcc: emailList.optional(),
  fallbackAccountIds: z.array(z.string()).max(5).optional(),
  scheduledAt: z.string().datetime().optional(),
});

interface Resolved {
  columns: { key: string; label: string; type: ColumnType; header?: string }[];
  rows: { id: string; data: Record<string, unknown> }[];
  emailKey: string | null;
  datasetId: string | null;
  sourceLabel: string;
}

async function resolveRecipients(session: AppSession, r: z.infer<typeof recipientsSchema>): Promise<Resolved | { error: string }> {
  if (r.kind === 'table') {
    const table = { headers: r.headers, rows: r.rows.map((row) => Object.fromEntries(r.headers.map((h) => [h, String(row[h] ?? '').trim()]))) };
    const columns = columnsFromTable(table, r.emailHeader);
    const email = columns.find((c) => c.type === ColumnType.EMAIL);
    return {
      columns,
      rows: table.rows.map((row, i) => ({ id: `row-${i}`, data: Object.fromEntries(columns.map((c) => [c.key, row[c.header] ?? ''])) })),
      emailKey: email?.key ?? null,
      datasetId: null,
      sourceLabel: `${table.rows.length} pasted / uploaded rows`,
    };
  }
  if (r.kind === 'segment') {
    const segment = await prisma.contactSegment.findUnique({ where: { id: r.segmentId } });
    if (!segment || segment.workspaceId !== session.workspaceId) return { error: 'Segment not found.' };
    const contacts = await prisma.contact.findMany({
      where: { workspaceId: segment.workspaceId, ...buildContactWhere(segment.filters as Record<string, unknown>) },
      select: { name: true, primaryEmail: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_ROWS,
    });
    return {
      columns: [
        { key: 'Name', label: 'Name', type: ColumnType.TEXT },
        { key: 'Email', label: 'Email', type: ColumnType.EMAIL },
      ],
      rows: contacts.map((c, i) => ({ id: `row-${i}`, data: { Name: c.name ?? '', Email: c.primaryEmail } })),
      emailKey: 'Email',
      datasetId: null,
      sourceLabel: `segment "${segment.name}"`,
    };
  }
  const dataset = await prisma.dataset.findFirst({
    where: { id: r.datasetId, workspaceId: session.workspaceId ?? '' },
    include: { columns: { orderBy: { order: 'asc' } } },
  });
  if (!dataset) return { error: 'Dataset not found in your workspace.' };
  const count = await prisma.record.count({ where: { datasetId: dataset.id } });
  if (count > MAX_ROWS) return { error: `This dataset has ${count} rows; Quick Send handles up to ${MAX_ROWS}. Use Campaigns for bigger lists.` };
  const records = await prisma.record.findMany({ where: { datasetId: dataset.id }, orderBy: { createdAt: 'asc' }, select: { id: true, data: true } });
  const email = dataset.columns.find((c) => c.type === ColumnType.EMAIL);
  return {
    columns: dataset.columns.map((c) => ({ key: c.key, label: c.label, type: c.type })),
    rows: records.map((rec) => ({ id: rec.id, data: (rec.data ?? {}) as Record<string, unknown> })),
    emailKey: email?.key ?? null,
    datasetId: dataset.id,
    sourceLabel: `dataset "${dataset.name}"`,
  };
}

/**
 * POST /api/quick-send — the one-screen send.
 *  mode "check": dry run + preview of the first recipient; nothing is saved.
 *  mode "send":  creates the data (when pasted / uploaded / a segment), the
 *                template and the campaign, then sends it the normal way (same
 *                pacing, limits, backups, tracking and inbox). Admins send at
 *                once; anyone else's goes to Approvals and sends automatically
 *                when approved.
 */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (session.viewingAs) return NextResponse.json({ error: 'Read-only while viewing as another user.' }, { status: 403 });
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  const body = bodySchema.parse(await req.json());

  const resolved = await resolveRecipients(session, body.recipients);
  if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: 400 });
  if (!resolved.emailKey) {
    return NextResponse.json({ error: 'No email column found. Name a column "Email", or paste one email address per line.' }, { status: 400 });
  }

  const subject = normalizeVariables(body.subject, resolved.columns);
  const html = body.format === 'html' ? normalizeVariables(body.body, resolved.columns) : textToHtml(normalizeVariables(body.body, resolved.columns));
  const plainText = htmlToPlainText(html);
  const keys = new Set(resolved.columns.map((c) => c.key));
  const unknownVariables = extractVariables(subject, html).filter((v) => !keys.has(v));

  const simulation = dryRun(resolved.rows, { emailColumnKey: resolved.emailKey, template: { subject, html, plainText }, origin: { campaignName: body.subject } });

  // Unsubscribed / bounced people are never emailed (checked again at send time).
  const sendableEmails = simulation.evaluations.filter((e) => e.willSend).map((e) => e.email!.toLowerCase());
  const suppressed = sendableEmails.length
    ? await prisma.emailSuppression.findMany({ where: { workspaceId: session.workspaceId, email: { in: sendableEmails } }, select: { email: true, reason: true } })
    : [];

  const sender = await senderAccountFor({ workspaceId: session.workspaceId, createdById: session.userId });
  const usage = sender ? await usageLast24h(sender.id) : null;
  const wouldSend = simulation.wouldSend - suppressed.length;
  const capacity = usage ? Math.max(0, dailyLimit() - usage.messages) : 0;

  if (body.mode === 'check') {
    const first = simulation.evaluations.find((e) => e.willSend);
    const firstRow = first ? resolved.rows.find((r) => r.id === first.recordId) : null;
    const preview = firstRow ? renderTemplate({ subject, html, plainText }, firstRow.data) : null;
    return NextResponse.json({
      source: resolved.sourceLabel,
      columns: resolved.columns.map((c) => ({ key: c.key, label: c.label })),
      emailColumn: resolved.emailKey,
      total: simulation.total,
      wouldSend,
      skipped: simulation.skipped + suppressed.length,
      byReason: { ...simulation.byReason, ...(suppressed.length ? { UNSUBSCRIBED_OR_BOUNCED: suppressed.length } : {}) },
      skippedExamples: [
        ...simulation.evaluations.filter((e) => !e.willSend).slice(0, 8).map((e) => ({ email: e.email ?? '(no email)', reason: e.reasonDetail ?? e.skipReason })),
        ...suppressed.slice(0, 3).map((s) => ({ email: s.email, reason: s.reason === 'BOUNCED' ? 'Bounced before' : 'Unsubscribed' })),
      ],
      unknownVariables,
      preview: preview && first ? { to: first.email, subject: preview.subject, html: sanitizeEmailHtml(preview.html), missingVariables: preview.missingVariables } : null,
      sender: sender ? { emailAddress: sender.emailAddress, status: sender.status, sentToday: usage?.messages ?? 0, capacityToday: capacity } : null,
      backups: await availableFallbackMailboxes(session.organizationId, sender?.id),
      estimatedMinutes: Math.ceil((Math.min(wouldSend, capacity || wouldSend) * 3.6) / 60),
      approval: session.role === Role.ADMIN || session.role === Role.SUPER_ADMIN ? 'none' : 'required',
    });
  }

  // ── send ──
  if (!sender || sender.status !== 'CONNECTED') {
    return NextResponse.json({ error: 'Connect your Gmail first: Settings → Gmail → Connect Gmail.' }, { status: 400 });
  }
  if (unknownVariables.length) {
    return NextResponse.json({ error: `These fields aren't in your list: ${unknownVariables.map((v) => `{{${v}}}`).join(', ')}. Fix or remove them.` }, { status: 400 });
  }
  if (wouldSend <= 0) return NextResponse.json({ error: 'Nobody to send to: every row was skipped. Check the reasons above.' }, { status: 400 });
  const fallback = await validateFallbackList(session.organizationId, sender.id, body.fallbackAccountIds ?? []);
  if (!fallback.ok) return NextResponse.json({ error: fallback.error }, { status: 400 });
  const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
  if (scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) return NextResponse.json({ error: 'The scheduled time is in the past.' }, { status: 400 });

  const stamp = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const name = `${body.subject.slice(0, 80)} · ${stamp}`;

  // 1. The list (a new dataset unless an existing one was picked).
  let datasetId = resolved.datasetId;
  if (!datasetId) {
    const dataset = await prisma.dataset.create({
      data: {
        organizationId: session.organizationId,
        workspaceId: session.workspaceId,
        ownerId: session.userId,
        name: `Quick send · ${name}`,
        description: `Recipients of a Quick Send (${resolved.sourceLabel}).`,
        columns: { create: resolved.columns.map((c, i) => ({ key: c.key, label: c.label, type: c.type, order: i + 1 })) },
      },
    });
    datasetId = dataset.id;
    await prisma.record.createMany({ data: resolved.rows.map((r) => ({ datasetId: dataset.id, data: r.data as Prisma.InputJsonValue })) });
  }
  // Contacts are linked before sending, so every reply threads into the Inbox.
  await linkContactsForDataset({ organizationId: session.organizationId, workspaceId: session.workspaceId, datasetId });

  // 2. The message, as a template version (what every send snapshots from).
  const template = await prisma.template.create({
    data: {
      organizationId: session.organizationId,
      workspaceId: session.workspaceId,
      ownerId: session.userId,
      name: `Quick send · ${name}`,
      description: QUICK_SEND_DESCRIPTION,
      versions: { create: { version: 1, subject, html, plainText, variables: extractVariables(subject, html, plainText), createdById: session.userId } },
    },
    include: { versions: true },
  });

  // 3. The campaign.
  const created = await prisma.campaign.create({
    data: {
      organizationId: session.organizationId,
      workspaceId: session.workspaceId,
      name,
      description: QUICK_SEND_DESCRIPTION,
      datasetId,
      templateId: template.id,
      templateVersionId: template.versions[0]!.id,
      createdById: session.userId,
      status: CampaignStatus.DRAFT,
      fromName: body.fromName?.trim() || null,
      replyTo: body.replyTo || null,
      ccEmails: body.cc ?? [],
      bccEmails: body.bcc ?? [],
      fallbackAccountIds: fallback.ids,
    },
  });
  await audit(session, 'QUICK_SEND', {
    targetType: 'Campaign',
    targetId: created.id,
    metadata: { recipients: wouldSend, source: body.recipients.kind, scheduledAt: scheduledAt?.toISOString(), backups: fallback.ids.length },
  });

  const isAdmin = session.role === Role.ADMIN || session.role === Role.SUPER_ADMIN;
  if (isAdmin) {
    const campaign = await loadCampaignForSession(session, created.id);
    const result = await startCampaignSend({ campaign: campaign!, actor: session, skipApproval: true, scheduledAt, via: 'quick-send' });
    if (!result.ok) return NextResponse.json({ ...result.body, campaignId: created.id }, { status: result.status });
    return NextResponse.json({ campaignId: created.id, state: scheduledAt && scheduledAt > new Date() ? 'scheduled' : 'sending', ...result.body }, { status: 201 });
  }

  // Not an admin: straight to Approvals; it sends by itself the moment it is approved.
  await prisma.campaign.update({ where: { id: created.id }, data: { status: CampaignStatus.PENDING_APPROVAL, submittedAt: new Date() } });
  await audit(session, 'CAMPAIGN_SUBMITTED_FOR_APPROVAL', { targetType: 'Campaign', targetId: created.id });
  await audit(session, QUICK_SEND_ON_APPROVAL, { targetType: 'Campaign', targetId: created.id, metadata: { scheduledAt: scheduledAt?.toISOString() ?? null } });
  const emailStatus = await sendApprovalRequestEmail(created.id, session);
  return NextResponse.json(
    { campaignId: created.id, state: 'awaiting_approval', note: 'Sent to an admin for approval. It goes out automatically as soon as it is approved.', emailStatus },
    { status: 201 },
  );
});

/** GET /api/quick-send — your recent Quick Sends with live progress and tracking. */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ sends: [] });
  const recent = await prisma.campaign.findMany({
    where: { workspaceId: session.workspaceId, description: QUICK_SEND_DESCRIPTION },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { id: true },
  });
  const sends = (await Promise.all(recent.map((c) => campaignStats(c.id)))).filter(Boolean);
  return NextResponse.json({ sends });
});
