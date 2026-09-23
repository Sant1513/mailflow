import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { generateSignedHtml } from '@/lib/documents/html';
import { placementsOf } from '@/lib/signing/placements';

/**
 * GET /api/sign/[token]/download
 * Returns the signed document as self-contained HTML, or with ?format=pdf the
 * signed PDF (the combined copy once every signer in a group has signed).
 * No authentication required — the token is the proof of access.
 */
export const GET = withErrorHandling(
  async (req, { params }: { params: { token: string } }) => {
    const request = await prisma.signingRequest.findUnique({
      where: { token: params.token },
    });

    if (!request || request.status !== 'SIGNED') {
      return NextResponse.json({ error: 'Document not found or not yet signed.' }, { status: 404 });
    }

    if (new URL(req.url).searchParams.get('format') === 'pdf') {
      const group = request.groupId
        ? await prisma.signingGroup.findUnique({ where: { id: request.groupId }, select: { combinedPdfData: true } })
        : null;
      const base64 = group?.combinedPdfData ?? request.signedPdfData;
      if (!base64) {
        return NextResponse.json({ error: 'The signed PDF is not available.' }, { status: 404 });
      }
      const pdf = Buffer.from(base64, 'base64');
      const filename = `${request.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_signed.pdf`;
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${filename}"`,
          'Content-Length': String(pdf.length),
        },
      });
    }

    const groupSigned = request.groupId
      ? await prisma.signingRequest.findMany({
          where: { groupId: request.groupId, status: 'SIGNED' },
          orderBy: { signerOrder: 'asc' },
          select: { signerOrder: true, signerRole: true, recipientName: true, signatureImage: true, signedAt: true },
        })
      : [{
          signerOrder: request.signerOrder,
          signerRole: request.signerRole,
          recipientName: request.recipientName,
          signatureImage: request.signatureImage,
          signedAt: request.signedAt,
        }];

    const html = generateSignedHtml({
      title: request.title,
      content: request.content,
      recipientName: request.recipientName,
      recipientEmail: request.recipientEmail,
      fieldValues: (request.fieldValues as Record<string, string>) ?? {},
      signatureImage: request.signatureImage ?? '',
      signedAt: request.signedAt ?? new Date(),
      signerIp: request.signerIp ?? 'unknown',
      signatureSlots: groupSigned.map((r) => ({
        signerIndex: r.signerOrder + 1,
        role: r.signerRole ?? `Signer ${r.signerOrder + 1}`,
        name: r.recipientName,
        image: r.signatureImage ?? undefined,
        signedAt: r.signedAt ?? undefined,
      })),
      placements: placementsOf(request.fieldValues),
    });

    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  }
);
