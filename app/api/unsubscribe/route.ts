import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { decodeUnsubToken } from '@/lib/email/tracking';

export async function POST(req: NextRequest) {
  const { token } = await req.json().catch(() => ({}));
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });

  const payload = decodeUnsubToken(token);
  if (!payload) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });

  await prisma.emailSuppression.upsert({
    where: { workspaceId_email: { workspaceId: payload.workspaceId, email: payload.email.toLowerCase() } },
    update: { reason: 'UNSUBSCRIBED', source: 'UNSUBSCRIBE' },
    create: { workspaceId: payload.workspaceId, email: payload.email.toLowerCase(), reason: 'UNSUBSCRIBED', source: 'UNSUBSCRIBE' },
  });

  return NextResponse.json({ ok: true });
}
