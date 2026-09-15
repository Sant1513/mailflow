import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { decodeTrackingToken } from '@/lib/email/tracking';

// 1×1 transparent GIF — minimal response size.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const payload = decodeTrackingToken(params.token);

  if (payload) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = req.headers.get('user-agent') ?? null;

    // Fire-and-forget — never block the pixel response on the DB write.
    prisma.emailTrackingEvent
      .create({
        data: {
          campaignId: payload.campaignId,
          emailJobId: payload.emailJobId,
          email: payload.email,
          type: 'OPEN',
          ip,
          userAgent,
        },
      })
      .catch(() => {/* non-critical — tracking events are best-effort */});
  }

  return new NextResponse(PIXEL, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}
