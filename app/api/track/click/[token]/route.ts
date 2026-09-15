import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { decodeTrackingToken } from '@/lib/email/tracking';

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const url = req.nextUrl.searchParams.get('u');
  const destination = url ? decodeURIComponent(url) : null;

  const payload = decodeTrackingToken(params.token);

  if (payload && destination) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = req.headers.get('user-agent') ?? null;

    prisma.emailTrackingEvent
      .create({
        data: {
          campaignId: payload.campaignId,
          emailJobId: payload.emailJobId,
          email: payload.email,
          type: 'CLICK',
          url: destination,
          ip,
          userAgent,
        },
      })
      .catch(() => {});
  }

  // Redirect to the destination. If token or URL is invalid, go to app root.
  const target = destination ?? '/';
  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    return new NextResponse('Bad request', { status: 400 });
  }
  return NextResponse.redirect(target, { status: 302 });
}
