import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { loadBlast, requireBlastAdmin } from '@/lib/recruiterSend/access';
import { kickRecruiterWorker } from '@/lib/recruiterSend/worker';
import { currentState, laptopOnline } from '@/lib/system/serverState';

/**
 * Pause, resume or cancel a recruiter send, or move it between the cloud and the laptop (to_laptop / to_cloud).
 * Messages already sent stay sent. Moving is safe at any moment: every message is claimed before it goes out, so
 * the cloud and the laptop can never both send the same one; one being sent right now simply finishes.
 */
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { action } = z.object({ action: z.enum(['pause', 'resume', 'cancel', 'to_laptop', 'to_cloud']) }).parse(await req.json());

  if (action === 'pause') {
    const res = await prisma.recruiterBlast.updateMany({ where: { id: blast.id, status: { in: ['SENDING', 'SCHEDULED'] } }, data: { status: 'PAUSED' } });
    if (!res.count) return NextResponse.json({ error: 'Only a send in progress or scheduled can be paused.' }, { status: 409 });
  } else if (action === 'resume') {
    const res = await prisma.recruiterBlast.updateMany({ where: { id: blast.id, status: 'PAUSED' }, data: { status: 'SENDING', startedAt: blast.startedAt ?? new Date(), note: null } });
    if (!res.count) return NextResponse.json({ error: 'Only a paused send can be resumed.' }, { status: 409 });
    // A laptop send is picked up again by the laptop's runner (or by the cloud once the laptop
    // has been silent for 10 minutes): no Vercel run for it here.
    if (blast.runOn !== 'laptop') kickRecruiterWorker('resume');
  } else if (action === 'to_laptop') {
    const s = await currentState();
    if (s.activeServer === 'laptop') return NextResponse.json({ error: 'MailFlow already runs on the laptop, so this send already goes out from there.' }, { status: 409 });
    if (!laptopOnline(s)) return NextResponse.json({ error: 'The laptop is offline right now. Switch when it is back (it must be on and connected).' }, { status: 409 });
    const res = await prisma.recruiterBlast.updateMany({ where: { id: blast.id, status: { in: ['SENDING', 'SCHEDULED', 'PAUSED'] }, runOn: 'cloud' }, data: { runOn: 'laptop', runOnChangedAt: null } });
    if (!res.count) return NextResponse.json({ error: 'This send cannot be moved to the laptop (it is not running, or is already there).' }, { status: 409 });
  } else if (action === 'to_cloud') {
    const res = await prisma.recruiterBlast.updateMany({ where: { id: blast.id, status: { in: ['SENDING', 'SCHEDULED', 'PAUSED'] }, runOn: 'laptop' }, data: { runOn: 'cloud', runOnChangedAt: null } });
    if (!res.count) return NextResponse.json({ error: 'This send cannot be moved to the cloud (it is not running, or is already there).' }, { status: 409 });
    if (blast.status === 'SENDING') kickRecruiterWorker('resume');
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
