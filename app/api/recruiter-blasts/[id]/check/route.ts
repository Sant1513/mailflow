import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastReader } from '@/lib/recruiterSend/access';
import { personalisedPreview, planBlast, planPageSchema } from '@/lib/recruiterSend/plan';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';

/**
 * The pre-send check and preview for a recruiter send (nothing is sent or saved). The plan is
 * worked out in full; the recruiter and batch tables come back one page at a time (body:
 * { peoplePage, peopleFilter, batch, q, batchPage }, all optional). Further pages come from
 * ./people, which skips the email preview.
 */
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastReader(); // read-only: nothing is sent or saved
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const query = planPageSchema.parse((await req.json().catch(() => null)) ?? {});
  const [plan, preview] = await Promise.all([planBlast(blast, query), personalisedPreview(blast)]);
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
