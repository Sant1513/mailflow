import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastReader } from '@/lib/recruiterSend/access';
import { personalisedPreview, planBlast } from '@/lib/recruiterSend/plan';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';

/** The pre-send check and preview for a recruiter send (nothing is sent or saved). */
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireBlastReader(); // read-only: nothing is sent or saved
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const [plan, preview] = await Promise.all([planBlast(blast), personalisedPreview(blast)]);
  return NextResponse.json({
    ...plan,
    eligible: plan.eligibleIds.length,
    eligibleIds: undefined,
    plannedAccountIds: undefined,
    skippedReasons: undefined,
    preview: sanitizeEmailHtml(preview.html),
    previewSubject: preview.subject,
    previewRecipient: preview.recipient,
  });
});
