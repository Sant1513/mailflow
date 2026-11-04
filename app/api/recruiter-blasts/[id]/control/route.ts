import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { loadBlast, requireBlastAdmin } from '@/lib/recruiterSend/access';
import { kickRecruiterWorker } from '@/lib/recruiterSend/worker';

/** Pause, resume or cancel a recruiter send. Messages already sent stay sent. */
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { action } = z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).parse(await req.json());

  if (action === 'pause') {
    const res = await prisma.recruiterBlast.updateMany({ where: { id: blast.id, status: { in: ['SENDING', 'SCHEDULED'] } }, data: { status: 'PAUSED' } });
    if (!res.count) return NextResponse.json({ error: 'Only a send in progress or scheduled can be paused.' }, { status: 409 });
  } else if (action === 'resume') {
    const res = await prisma.recruiterBlast.updateMany({ where: { id: blast.id, status: 'PAUSED' }, data: { status: 'SENDING', startedAt: blast.startedAt ?? new Date(), note: null } });
    if (!res.count) return NextResponse.json({ error: 'Only a paused send can be resumed.' }, { status: 409 });
    kickRecruiterWorker('resume');
  } else {
    const res = await prisma.recruiterBlast.updateMany({ where: { id: blast.id, status: { in: ['SENDING', 'SCHEDULED', 'PAUSED'] } }, data: { status: 'CANCELLED', completedAt: new Date() } });
    if (!res.count) return NextResponse.json({ error: 'This send can no longer be cancelled.' }, { status: 409 });
    // Only messages not yet picked up; one being sent right now finishes and is recorded as sent.
    await prisma.recruiterBlastRecipient.updateMany({ where: { blastId: blast.id, status: 'QUEUED', group: { status: 'PENDING' } }, data: { status: 'SKIPPED', skipReason: 'Cancelled before sending' } });
    await prisma.recruiterBlastGroup.updateMany({ where: { blastId: blast.id, status: 'PENDING' }, data: { status: 'FAILED', error: 'Cancelled before sending' } });
  }
  await audit(session, `RECRUITER_SEND_${action.toUpperCase()}`, { targetType: 'RecruiterBlast', targetId: blast.id });
  return NextResponse.json({ ok: true });
});
