import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { automatedReason } from '@/lib/email/botDetect';
import { readOpenToken } from '@/lib/recruiterSend/core';

/**
 * Open pixel for Recruiter Bulk Send (separate from campaign tracking). Counts opens per Gmail
 * message: a BCC group (every recruiter in it shares the image, so it can't say who) or an
 * individual copy (one recruiter). Prefetches and scanners don't count (lib/email/botDetect.ts).
 */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const groupId = readOpenToken(params.token);
  if (groupId) {
    try {
      const group = await prisma.recruiterBlastGroup.findUnique({ where: { id: groupId }, select: { id: true, sentAt: true, status: true, blast: { select: { mode: true } } } });
      const now = new Date();
      if (group && group.status === 'SENT' && !automatedReason({ type: 'OPEN', userAgent: req.headers.get('user-agent'), sentAt: group.sentAt, at: now })) {
        await prisma.recruiterBlastGroup.update({
          where: { id: group.id },
          data: { openCount: { increment: 1 }, lastOpenedAt: now },
        });
        await prisma.recruiterBlastGroup.updateMany({ where: { id: group.id, firstOpenedAt: null }, data: { firstOpenedAt: now } });
        if (group.blast.mode === 'INDIVIDUAL') {
          await prisma.recruiterBlastRecipient.updateMany({ where: { groupId: group.id }, data: { openCount: { increment: 1 } } });
          await prisma.recruiterBlastRecipient.updateMany({ where: { groupId: group.id, openedAt: null }, data: { openedAt: now } });
        }
      }
    } catch {
      /* tracking is best effort */
    }
  }
  return new NextResponse(new Uint8Array(PIXEL), {
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate', Pragma: 'no-cache', Expires: '0' },
  });
}
