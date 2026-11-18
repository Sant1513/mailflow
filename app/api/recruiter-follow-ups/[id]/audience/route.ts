import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastAdmin, requireBlastReader } from '@/lib/recruiterSend/access';
import { addToAudience, applyAudience, chainCandidates, FOLLOW_UP_SEGMENTS, parseSegments, segmentCounts, segmentOf } from '@/lib/recruiterSend/followUp';
import { isValidEmail } from '@/lib/quickSend/prepare';

/**
 * Who a follow-up goes to. GET: everyone who was sent an email in the chain (page of 50, search
 * `q`, `show` = all | selected | replied) with their state and whether they are ticked for this
 * follow-up, plus counts for every audience. POST (drafts only):
 *   { action: 'apply', segments }       replace the list with the ticked segments (none = nobody)
 *   { action: 'select', emails, selected }  tick / untick recruiters
 *   { action: 'add', text }             add addresses (recruiters of the chain, or new ones)
 */
export const dynamic = 'force-dynamic';
const PAGE = 50;

export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastReader();
  const blast = await loadBlast(session, params.id);
  if (!blast || !blast.parentBlastId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 200);
  const show = url.searchParams.get('show') ?? 'all';
  const rawPage = Math.floor(Number(url.searchParams.get('page') ?? '1'));
  const rootId = blast.rootBlastId ?? blast.id;

  const [all, chosenRows] = await Promise.all([
    chainCandidates(rootId),
    prisma.recruiterBlastRecipient.findMany({ where: { blastId: blast.id }, select: { email: true } }),
  ]);
  const chosen = new Set(chosenRows.map((r) => r.email.toLowerCase()));
  const known = new Set(all.map((c) => c.email));
  const rows = all
    .filter((c) => (!q || c.email.includes(q) || (c.name ?? '').toLowerCase().includes(q)) && (show === 'selected' ? chosen.has(c.email) : show === 'replied' ? c.replied : true))
    .sort((a, b) => a.email.localeCompare(b.email));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const page = Math.min(pages, Math.max(1, Number.isFinite(rawPage) ? rawPage : 1));
  return NextResponse.json({
    segments: parseSegments(blast.followUpAudience),
    counts: segmentCounts(all),
    selected: chosen.size,
    // Ticked recruiters that were not in the chain (added by address).
    added: [...chosen].filter((e) => !known.has(e)).length,
    total: rows.length,
    page,
    pages,
    perPage: PAGE,
    status: blast.status,
    candidates: rows.slice((page - 1) * PAGE, page * PAGE).map((c) => ({
      email: c.email,
      name: c.name,
      segment: segmentOf(c),
      replied: c.replied,
      opened: c.opened,
      bounced: c.bounced,
      lastSentAt: c.lastSentAt,
      selected: chosen.has(c.email),
    })),
  });
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('apply'), segments: z.array(z.enum(FOLLOW_UP_SEGMENTS)).max(FOLLOW_UP_SEGMENTS.length) }),
  z.object({ action: z.literal('select'), emails: z.array(z.string().max(320)).min(1).max(5000), selected: z.boolean() }),
  z.object({ action: z.literal('add'), text: z.string().max(200_000) }),
]);

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast || !blast.parentBlastId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (blast.status !== 'DRAFT') return NextResponse.json({ error: 'Only a draft can change who it goes to.' }, { status: 409 });
  const body = bodySchema.parse(await req.json());
  const rootId = blast.rootBlastId ?? blast.id;

  if (body.action === 'apply') {
    const count = await applyAudience(blast.id, rootId, body.segments);
    return NextResponse.json({ ok: true, selected: count });
  }
  if (body.action === 'select') {
    const emails = [...new Set(body.emails.map((e) => e.trim().toLowerCase()))];
    if (body.selected) {
      const res = await addToAudience(blast.id, rootId, emails);
      return NextResponse.json({ ok: true, added: res.added, skippedBounced: res.skippedBounced });
    }
    const res = await prisma.recruiterBlastRecipient.deleteMany({ where: { blastId: blast.id, email: { in: emails } } });
    return NextResponse.json({ ok: true, removed: res.count });
  }
  const found = body.text.match(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const valid = [...new Set(found.map((e) => e.toLowerCase()))].filter(isValidEmail);
  if (!valid.length) return NextResponse.json({ error: 'No email address found in that text.' }, { status: 400 });
  if (valid.length > 5000) return NextResponse.json({ error: 'Add up to 5,000 addresses at a time.' }, { status: 400 });
  const res = await addToAudience(blast.id, rootId, valid);
  if (!res.added && res.skippedBounced) return NextResponse.json({ error: res.skippedBounced === 1 ? 'That address bounced before, so it is never included.' : `${res.skippedBounced} of those addresses bounced before, so they are never included.` }, { status: 400 });
  return NextResponse.json({ ok: true, added: res.added, fromChain: res.fromChain, newAddresses: res.added - res.fromChain, skippedBounced: res.skippedBounced });
});
