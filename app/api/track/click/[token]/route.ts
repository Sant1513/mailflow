import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { decodeTrackingToken, isValidClickDestination } from '@/lib/email/tracking';
import { escapeHtml } from '@/lib/signing/fields';

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  // searchParams are already decoded; decoding again corrupts URLs with encoded query values.
  const destination = req.nextUrl.searchParams.get('u');
  let target: URL;
  try {
    target = new URL(destination ?? '');
  } catch {
    return new NextResponse('Bad request', { status: 400 });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return new NextResponse('Bad request', { status: 400 });
  }

  const payload = decodeTrackingToken(params.token);
  const verified = !!payload && isValidClickDestination(params.token, destination!, req.nextUrl.searchParams.get('s'));

  if (payload && verified) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = req.headers.get('user-agent') ?? null;
    await prisma.emailTrackingEvent
      .create({
        data: {
          campaignId: payload.campaignId,
          emailJobId: payload.emailJobId,
          email: payload.email,
          type: 'CLICK',
          url: target.toString(),
          ip,
          userAgent,
        },
      })
      .catch(() => {});
    return NextResponse.redirect(target, { status: 302 });
  }

  // The link wasn't signed for this destination: don't bounce people to it
  // silently (that would make us an open redirect) — let them choose.
  const safe = escapeHtml(target.toString());
  return new NextResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leaving MailFlow</title></head>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;color:#1f2937">
<h1 style="font-size:18px">You are leaving MailFlow</h1>
<p style="font-size:14px;color:#4b5563">This link points to:</p>
<p style="font-size:14px;word-break:break-all"><a href="${safe}" rel="noopener noreferrer nofollow">${safe}</a></p>
<p style="font-size:12px;color:#9ca3af">Only continue if you trust this address.</p>
</body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } },
  );
}
