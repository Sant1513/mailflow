import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';

/** GET /api/signing-groups/[id]/download — download the combined signed PDF for a completed group. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }

  const group = await prisma.signingGroup.findFirst({
    where: { id: params.id, workspaceId: session.workspaceId },
    include: {
      requests: {
        select: { title: true },
        orderBy: { signerOrder: 'asc' },
        take: 1,
      },
    },
  });

  if (!group) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  if (!group.combinedPdfData) {
    return NextResponse.json({ error: 'Combined PDF not yet available — signing is still in progress.' }, { status: 404 });
  }

  const pdfBuffer = Buffer.from(group.combinedPdfData, 'base64');
  const title = group.requests[0]?.title ?? 'signed_document';
  const filename = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_complete.pdf`;

  return new NextResponse(pdfBuffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(pdfBuffer.length),
    },
  });
});
