import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { readListUnsubscribeToken } from '@/lib/recruiterSend/core';

/**
 * Unsubscribe page for BCC recruiter sends. A BCC email is the same for every recipient, so
 * the link can't say who clicked: the recruiter types their address. Only an address that was
 * on that send can be unsubscribed (nobody can remove someone else from another list).
 */
export const dynamic = 'force-dynamic';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribe</title>
<style>:root{color-scheme:light dark}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#f6f7f9;color:#1f2937;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{width:100%;max-width:440px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;box-sizing:border-box}h1{font-size:20px;margin:0 0 8px}p{color:#4b5563;line-height:1.5}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font:15px system-ui,Arial,sans-serif;margin:8px 0;background:inherit;color:inherit}button{background:#111827;color:#fff;border:0;border-radius:8px;padding:10px 16px;font:600 15px system-ui,Arial,sans-serif;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#111827;color:#f3f4f6}main{background:#1f2937;border-color:#374151}p{color:#d1d5db}button{background:#f3f4f6;color:#111827}}</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

const form = (token: string, message = '') =>
  page(`<h1>Unsubscribe</h1><p>Enter the email address this message was sent to, and you won't get these emails again.</p>${message ? `<p><b>${esc(message)}</b></p>` : ''}<form method="post" action="/unsubscribe/list/${esc(token)}"><input type="email" name="email" required placeholder="you@company.com" autocomplete="email"><button>Unsubscribe</button></form>`);

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  if (!readListUnsubscribeToken(params.token)) return page('<h1>Link not valid</h1><p>Reply to the email and ask to be removed instead.</p>', 400);
  return form(params.token);
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const blastId = readListUnsubscribeToken(params.token);
  if (!blastId) return page('<h1>Link not valid</h1><p>Reply to the email and ask to be removed instead.</p>', 400);
  const email = String((await req.formData().catch(() => null))?.get('email') ?? '').trim().toLowerCase();
  const blast = await prisma.recruiterBlast.findUnique({ where: { id: blastId }, select: { workspaceId: true } });
  const wasSent = email && blast ? await prisma.recruiterBlastRecipient.findUnique({ where: { blastId_email: { blastId, email } }, select: { id: true } }) : null;
  if (!blast || !wasSent) return form(params.token, "That address wasn't on this email. Check the spelling, or reply to the email instead.");
  await prisma.emailSuppression.upsert({
    where: { workspaceId_email: { workspaceId: blast.workspaceId, email } },
    create: { workspaceId: blast.workspaceId, email, reason: 'UNSUBSCRIBED', source: 'UNSUBSCRIBE', detail: 'Recruiter bulk send (BCC) unsubscribe page' },
    update: {},
  });
  return page(`<h1>You're unsubscribed</h1><p>${esc(email)} won't get these emails again.</p>`);
}
