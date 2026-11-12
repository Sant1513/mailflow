import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ColumnType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastAdmin, requireBlastReader } from '@/lib/recruiterSend/access';
import { parseRecipientFile, parseRecipientPaste, type RecipientList } from '@/lib/recruiterSend/core';

/**
 * GET: one page of the recruiter list with every uploaded column, for the "Preview list" table
 * (`?page=` 1-based, 50 a page; `?q=` searches email and name).
 * POST: replaces a draft's recruiter list from pasted text, an uploaded CSV/Excel file, or saved data.
 * Every column is kept (RecruiterBlast.columns + each recruiter's row in data) so the email can
 * use {{Column}} — names, companies, per-recruiter UTM links. `emailColumn` picks the address
 * column when the guess is wrong.
 */
export const dynamic = 'force-dynamic';
const MAX_RECIPIENTS = 20_000;
const PREVIEW_PAGE_SIZE = 50; // route files may only export handlers and route config

export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastReader();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const url = new URL(req.url);
  const rawPage = Math.floor(Number(url.searchParams.get('page') ?? '1'));
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 100_000) : 1;
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  const where: Prisma.RecruiterBlastRecipientWhereInput = {
    blastId: blast.id,
    ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.recruiterBlastRecipient.count({ where }),
    prisma.recruiterBlastRecipient.findMany({
      where,
      // Ids are created in list order, so this keeps the order of the sheet.
      orderBy: { id: 'asc' },
      skip: (page - 1) * PREVIEW_PAGE_SIZE,
      take: PREVIEW_PAGE_SIZE,
      select: { email: true, name: true, status: true, data: true },
    }),
  ]);
  return NextResponse.json({
    columns: blast.columns ?? [],
    emailColumn: blast.emailColumn ?? null,
    status: blast.status,
    q,
    page,
    perPage: PREVIEW_PAGE_SIZE,
    pages: Math.max(1, Math.ceil(total / PREVIEW_PAGE_SIZE)),
    total,
    recipients: rows.map((r) => ({
      email: r.email,
      name: r.name,
      status: r.status,
      data: r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : {},
    })),
  });
});

const emailColumn = z.string().max(200).nullish();
const bodySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('paste'), text: z.string().max(2_000_000), emailColumn }),
  z.object({ source: z.literal('file'), fileName: z.string().max(200), base64: z.string().max(15_000_000), emailColumn }),
  z.object({ source: z.literal('dataset'), datasetId: z.string().min(1), emailColumn }),
]);

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (blast.status !== 'DRAFT') return NextResponse.json({ error: 'Only a draft can change its recipients.' }, { status: 409 });
  const body = bodySchema.parse(await req.json());

  let list: RecipientList;
  let source = '';
  if (body.source === 'paste') {
    list = parseRecipientPaste(body.text, body.emailColumn);
    source = 'pasted list';
  } else if (body.source === 'file') {
    list = parseRecipientFile(Buffer.from(body.base64, 'base64'), body.fileName, body.emailColumn);
    source = `file "${body.fileName}"`;
  } else {
    const dataset = await prisma.dataset.findFirst({
      where: { id: body.datasetId, organizationId: session.organizationId, ...(session.role === 'SUPER_ADMIN' ? {} : { workspaceId: session.workspaceId! }) },
      select: { id: true, name: true, columns: { orderBy: { order: 'asc' }, select: { key: true, label: true, type: true } } },
    });
    if (!dataset) return NextResponse.json({ error: 'That data list was not found.' }, { status: 404 });
    const chosen = body.emailColumn ? dataset.columns.find((c) => c.label === body.emailColumn) : null;
    const emailCol = chosen ?? dataset.columns.find((c) => c.type === ColumnType.EMAIL);
    if (!emailCol) return NextResponse.json({ error: `"${dataset.name}" has no email column.` }, { status: 400 });
    const nameCol = dataset.columns.find((c) => c.key !== emailCol.key && /^(full ?)?name$|recruiter|contact name|^poc/i.test(c.label.trim())) ?? null;
    const rows = await prisma.record.findMany({ where: { datasetId: dataset.id }, select: { data: true }, take: MAX_RECIPIENTS * 2 });
    const seen = new Map<string, RecipientList['recipients'][number]>();
    for (const r of rows) {
      const raw = (r.data ?? {}) as Record<string, unknown>;
      const email = String(raw[emailCol.key] ?? '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      // Kept by the column's label, the name people see and type as {{Label}}.
      const data: Record<string, string> = {};
      for (const c of dataset.columns) data[c.label] = raw[c.key] == null ? '' : String(raw[c.key]).trim().slice(0, 2000);
      seen.set(email, { email, name: nameCol ? data[nameCol.label] || null : null, data });
    }
    list = { recipients: [...seen.values()], columns: dataset.columns.map((c) => c.label), emailColumn: emailCol.label, unreadable: [] };
    source = `data "${dataset.name}"`;
  }
  if (list.error) return NextResponse.json({ error: list.error, columns: list.columns }, { status: 400 });
  const { recipients, unreadable } = list;

  if (recipients.length > MAX_RECIPIENTS) return NextResponse.json({ error: `That is ${recipients.length.toLocaleString()} addresses; one send takes up to ${MAX_RECIPIENTS.toLocaleString()}.` }, { status: 400 });

  await prisma.$transaction(async (tx) => {
    await tx.recruiterBlastRecipient.deleteMany({ where: { blastId: blast.id } });
    await tx.recruiterBlast.update({ where: { id: blast.id }, data: { columns: list.columns, emailColumn: list.emailColumn } });
    for (let i = 0; i < recipients.length; i += 1000) {
      await tx.recruiterBlastRecipient.createMany({
        data: recipients.slice(i, i + 1000).map((r) => ({ blastId: blast.id, email: r.email, name: r.name, data: r.data ? (r.data as Prisma.InputJsonValue) : Prisma.JsonNull })),
        skipDuplicates: true,
      });
    }
  }, { timeout: 60_000 });

  return NextResponse.json({ added: recipients.length, unreadable: unreadable.slice(0, 20), unreadableCount: unreadable.length, source, columns: list.columns, emailColumn: list.emailColumn });
});
