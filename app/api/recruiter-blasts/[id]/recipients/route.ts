import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ColumnType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastAdmin } from '@/lib/recruiterSend/access';
import { parseRecipientFile, parseRecipientPaste, type RecipientList } from '@/lib/recruiterSend/core';

/**
 * Replaces a draft's recruiter list from pasted text, an uploaded CSV/Excel file, or saved data.
 * Every column is kept (RecruiterBlast.columns + each recruiter's row in data) so the email can
 * use {{Column}} — names, companies, per-recruiter UTM links. `emailColumn` picks the address
 * column when the guess is wrong.
 */
export const dynamic = 'force-dynamic';
const MAX_RECIPIENTS = 20_000;

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
