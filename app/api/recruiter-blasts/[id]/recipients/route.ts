import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ColumnType } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastAdmin } from '@/lib/recruiterSend/access';
import { parseRecipientFile, parseRecipientText, type Recipient } from '@/lib/recruiterSend/core';

/** Replaces a draft's recruiter list from pasted text, an uploaded CSV/Excel file, or saved data. */
export const dynamic = 'force-dynamic';
const MAX_RECIPIENTS = 20_000;

const bodySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('paste'), text: z.string().max(2_000_000) }),
  z.object({ source: z.literal('file'), fileName: z.string().max(200), base64: z.string().max(15_000_000) }),
  z.object({ source: z.literal('dataset'), datasetId: z.string().min(1) }),
]);

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (blast.status !== 'DRAFT') return NextResponse.json({ error: 'Only a draft can change its recipients.' }, { status: 409 });
  const body = bodySchema.parse(await req.json());

  let recipients: Recipient[] = [];
  let unreadable: string[] = [];
  let source = '';
  if (body.source === 'paste') {
    ({ recipients, unreadable } = parseRecipientText(body.text));
    source = 'pasted list';
  } else if (body.source === 'file') {
    const parsed = parseRecipientFile(Buffer.from(body.base64, 'base64'), body.fileName);
    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
    recipients = parsed.recipients;
    source = `file "${body.fileName}"`;
  } else {
    const dataset = await prisma.dataset.findFirst({
      where: { id: body.datasetId, organizationId: session.organizationId, ...(session.role === 'SUPER_ADMIN' ? {} : { workspaceId: session.workspaceId! }) },
      select: { id: true, name: true, columns: { select: { key: true, label: true, type: true } } },
    });
    if (!dataset) return NextResponse.json({ error: 'That data list was not found.' }, { status: 404 });
    const emailKey = dataset.columns.find((c) => c.type === ColumnType.EMAIL)?.key;
    if (!emailKey) return NextResponse.json({ error: `"${dataset.name}" has no email column.` }, { status: 400 });
    const nameKey = dataset.columns.find((c) => /^(full ?)?name$|recruiter|contact name|^poc/i.test(c.label.trim()))?.key ?? null;
    const rows = await prisma.record.findMany({ where: { datasetId: dataset.id }, select: { data: true }, take: MAX_RECIPIENTS * 2 });
    const seen = new Map<string, Recipient>();
    for (const r of rows) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      const email = String(data[emailKey] ?? '').trim().toLowerCase();
      if (email && !seen.has(email)) seen.set(email, { email, name: nameKey ? String(data[nameKey] ?? '').trim() || null : null });
    }
    recipients = [...seen.values()];
    source = `data "${dataset.name}"`;
  }

  if (recipients.length > MAX_RECIPIENTS) return NextResponse.json({ error: `That is ${recipients.length.toLocaleString()} addresses; one send takes up to ${MAX_RECIPIENTS.toLocaleString()}.` }, { status: 400 });

  await prisma.$transaction(async (tx) => {
    await tx.recruiterBlastRecipient.deleteMany({ where: { blastId: blast.id } });
    for (let i = 0; i < recipients.length; i += 1000) {
      await tx.recruiterBlastRecipient.createMany({
        data: recipients.slice(i, i + 1000).map((r) => ({ blastId: blast.id, email: r.email, name: r.name })),
        skipDuplicates: true,
      });
    }
  }, { timeout: 60_000 });

  return NextResponse.json({ added: recipients.length, unreadable: unreadable.slice(0, 20), unreadableCount: unreadable.length, source });
});
