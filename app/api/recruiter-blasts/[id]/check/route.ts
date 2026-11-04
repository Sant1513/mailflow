import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastAdmin } from '@/lib/recruiterSend/access';
import { planBlast } from '@/lib/recruiterSend/plan';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';
import { previewHtml } from '@/lib/recruiterSend/core';

/** The pre-send check and preview for a recruiter send (nothing is sent or saved). */
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const plan = await planBlast(blast);
  return NextResponse.json({
    ...plan,
    eligible: plan.eligibleIds.length,
    eligibleIds: undefined,
    skippedReasons: undefined,
    preview: sanitizeEmailHtml(previewHtml(blast)),
  });
});
