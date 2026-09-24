import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { generateSignedPdfDetailed } from '@/lib/documents/pdf';
import { signaturePlacementsSchema } from '@/lib/signing/placements';

// First PDF on a cold server starts Chromium, which can take several seconds.
export const maxDuration = 60;

const previewSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(500_000),
  recipientName: z.string().max(200).default(''),
  recipientEmail: z.string().max(320).default(''),
  fieldValues: z.record(z.string()).default({}),
  signers: z.array(z.object({ role: z.string().max(100), name: z.string().max(200).optional() })).max(3).default([]),
  placements: signaturePlacementsSchema.default([]),
});

/**
 * POST /api/e-sign/preview — render the unsigned document as a PDF preview.
 * X-Page-Count tells the placement editor how many pages to draw.
 */
export const POST = withErrorHandling(async (req) => {
  await requireSession();
  const body = previewSchema.parse(await req.json());

  const { pdf, pageCount } = await generateSignedPdfDetailed({
    title: body.title,
    content: body.content,
    recipientName: body.recipientName || body.signers[0]?.name || 'Recipient',
    recipientEmail: body.recipientEmail,
    fieldValues: body.fieldValues,
    signatureImage: '',
    signedAt: new Date(),
    signerIp: '',
    preview: true,
    placements: body.placements,
    signatureSlots: body.signers.map((s, i) => ({ signerIndex: i + 1, role: s.role, name: s.name })),
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="preview.pdf"',
      'Cache-Control': 'no-store',
      'X-Page-Count': String(pageCount),
    },
  });
});
