import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { generateSignedHtml } from '@/lib/documents/html';

/**
 * GET /api/sign/[token]/download
 * Returns a self-contained signed HTML document as a downloadable attachment.
 * No authentication required — the token is the proof of access.
 */
export const GET = withErrorHandling(
  async (_req, { params }: { params: { token: string } }) => {
    const request = await prisma.signingRequest.findUnique({
      where: { token: params.token },
    });

    if (!request || request.status !== 'SIGNED') {
      return NextResponse.json({ error: 'Document not found or not yet signed.' }, { status: 404 });
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
    });

    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  }
);
