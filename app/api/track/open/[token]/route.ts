import { NextResponse, type NextRequest } from 'next/server';
import { recordTrackingEvent } from '@/lib/email/trackingEvents';
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

    // Awaited: on serverless hosts work left running after the response can be
    // frozen and lost. Failures are swallowed inside — tracking is best-effort.
    await recordTrackingEvent({ type: 'OPEN', campaignId: payload.campaignId, emailJobId: payload.emailJobId, email: payload.email, ip, userAgent });
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
