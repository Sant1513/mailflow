import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { generateSignedPdf } from '@/lib/documents/pdf';
import { lockedFieldsOf, publicSigningFieldValues } from '@/lib/signing/fields';
import { placementsOf } from '@/lib/signing/placements';

const previewSchema = z.object({
  fieldValues: z.record(z.string().max(5000)).default({}),
});

/**
 * POST /api/sign/[token]/preview — the signer's unsigned PDF, including what
 * they have typed so far and where their signature will be placed.
 * Public: the token is the proof of access, and nothing is saved.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { token: string } }) => {
  const request = await prisma.signingRequest.findUnique({ where: { token: params.token } });
  if (!request || !['SENT', 'VIEWED'].includes(request.status)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (request.expiresAt && request.expiresAt < new Date()) {
    return NextResponse.json({ error: 'expired' }, { status: 410 });
  }

  const body = previewSchema.parse(await req.json());
  const locked = lockedFieldsOf(request.fieldValues);
  const assigned = request.assignedFields ?? [];
  const values = publicSigningFieldValues(request.fieldValues as Record<string, unknown>);
  for (const [key, value] of Object.entries(body.fieldValues)) {
    if (key.startsWith('__') || locked.includes(key)) continue;
    if (assigned.length > 0 && !assigned.includes(key)) continue;
    values[key] = value;
  }

  const members = request.groupId
    ? await prisma.signingRequest.findMany({
        where: { groupId: request.groupId, status: { not: 'VOIDED' } },
        orderBy: { signerOrder: 'asc' },
        select: { signerOrder: true, signerRole: true, recipientName: true, status: true, signatureImage: true, signedAt: true },
      })
    : [{ signerOrder: request.signerOrder, signerRole: request.signerRole, recipientName: request.recipientName, status: request.status, signatureImage: null, signedAt: null }];

  const pdf = await generateSignedPdf({
    title: request.title,
    content: request.content,
    recipientName: request.recipientName,
    recipientEmail: request.recipientEmail,
    fieldValues: values,
    signatureImage: '',
    signedAt: new Date(),
    signerIp: '',
    preview: true,
    highlightSigner: request.signerOrder + 1,
    placements: placementsOf(request.fieldValues),
    signatureSlots: members.map((m) => ({
      signerIndex: m.signerOrder + 1,
      role: m.signerRole ?? `Signer ${m.signerOrder + 1}`,
      name: m.recipientName,
      image: m.status === 'SIGNED' ? m.signatureImage ?? undefined : undefined,
      signedAt: m.status === 'SIGNED' ? m.signedAt ?? undefined : undefined,
    })),
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="preview.pdf"',
      'Cache-Control': 'no-store',
    },
  });
});
