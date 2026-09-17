import { prisma } from '@/lib/db/client';
import { audit } from '@/lib/audit/log';

/** Returns a standalone HTML page with inline CSS — no auth required. */
function htmlPage(title: string, body: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f9fafb;
      color: #1f2937;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 40px 32px;
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    .logo { font-size: 14px; color: #6b7280; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 12px; }
    p { font-size: 15px; color: #4b5563; margin-bottom: 20px; line-height: 1.6; }
    .email { font-weight: 600; color: #111; }
    .btn {
      display: inline-block;
      background: #dc2626;
      color: #fff;
      padding: 12px 28px;
      border-radius: 6px;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      border: none;
      cursor: pointer;
      width: 100%;
    }
    .btn:hover { background: #b91c1c; }
    .note { font-size: 12px; color: #9ca3af; margin-top: 16px; }
    .success { font-size: 36px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">MailFlow · Masai School</div>
    ${body}
  </div>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function notFoundPage(): Response {
  return new Response(
    `<!DOCTYPE html><html><head><title>Not Found</title></head><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>Link not found</h1><p>This unsubscribe link is invalid or has expired.</p></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/** GET /api/unsubscribe/[token] — show confirmation page. */
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const job = await prisma.emailJob.findUnique({
    where: { unsubscribeToken: params.token },
    select: { id: true, toEmail: true },
  });

  if (!job) return notFoundPage();

  const body = `
    <h1>Unsubscribe from Masai School emails</h1>
    <p>You are about to unsubscribe <span class="email">${job.toEmail}</span> from future campaign emails.</p>
    <form method="POST">
      <button type="submit" class="btn">Confirm Unsubscribe</button>
    </form>
    <p class="note">You will no longer receive campaign emails at this address.</p>`;

  return htmlPage('Unsubscribe', body);
}

/** POST /api/unsubscribe/[token] — add to suppression list. */
export async function POST(_req: Request, { params }: { params: { token: string } }) {
  const job = await prisma.emailJob.findUnique({
    where: { unsubscribeToken: params.token },
    include: { campaign: { select: { workspaceId: true, organizationId: true } } },
  });

  if (!job) return notFoundPage();

  const workspaceId = job.campaign.workspaceId;

  await prisma.emailSuppression.upsert({
    where: { workspaceId_email: { workspaceId, email: job.toEmail } },
    create: {
      workspaceId,
      email: job.toEmail,
      reason: 'UNSUBSCRIBED',
      source: 'UNSUBSCRIBE',
    },
    update: {},
  });

  // Fire-and-forget audit log (no session — public route)
  audit(
    { organizationId: job.campaign.organizationId },
    'UNSUBSCRIBE',
    { targetType: 'EmailJob', targetId: job.id, metadata: { email: job.toEmail } }
  ).catch(() => undefined);

  const body = `
    <div class="success">✓</div>
    <h1>You've been unsubscribed</h1>
    <p>The address <span class="email">${job.toEmail}</span> has been removed from our mailing list and will not receive further campaign emails.</p>
    <p class="note">If this was a mistake, please contact your Masai School advisor directly.</p>`;

  return htmlPage("You've been unsubscribed", body);
}
