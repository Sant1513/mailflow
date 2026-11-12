import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastReader } from '@/lib/recruiterSend/access';
import { planBlast, planPageSchema, planPageView } from '@/lib/recruiterSend/plan';

/**
 * One page of the pre-send check's tables (recruiters and batches), for paging, filtering and
 * searching without sending the whole list to the browser. The plan is worked out again here
 * (same as the check), but the email preview is not. Nothing is sent or saved.
 */
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastReader();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const query = planPageSchema.parse((await req.json().catch(() => null)) ?? {});
  // A page turn: reuse the plan from the last minute rather than re-checking every recruiter.
  const plan = await planBlast(blast, { ...query, reuse: true });
  return NextResponse.json(planPageView(plan));
});
