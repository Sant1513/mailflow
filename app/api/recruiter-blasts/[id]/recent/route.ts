import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { checkAddresses } from '@/lib/email/addressCheck';
import { isValidEmail } from '@/lib/quickSend/prepare';
import { loadBlast, requireBlastAdmin, requireBlastReader } from '@/lib/recruiterSend/access';
import { forgetPlan } from '@/lib/recruiterSend/plan';
import { coolOffs, recentContacts, repeatWindow, type RecentContact } from '@/lib/recruiterSend/recent';
import { emailKey } from '@/lib/recruiterSend/emailKey';
import { csvResponse, istDateTime, toCsv } from '@/lib/export/csv';

/**
 * Recruiters in this send who were already emailed from MailFlow inside the repeat window
 * (default 10 days), with the last email they got (subject, date, mailbox, which send).
 *
 * GET  ?page=&q=&show=skipped|included|all&sort=newest|oldest|email&format=csv
 *      → one page (50) of them, or the whole filtered list as a CSV.
 * POST { action, scope }  → bulk actions on the draft:
 *      action "include"  send again to them          (sets repeatOk)
 *      action "skip"     leave them out (the default) (clears repeatOk)
 *      action "remove"   take them out of this list
 *      scope { emails: [...] }                          the ticked ones (up to 5,000)
 *            { all: true, q?, show?, olderThanDays? }   everyone matching, across all pages
 * Follow-ups are exempt from the guard, so there is nothing to review for them.
 */
export const dynamic = 'force-dynamic';
const PAGE_SIZE = 50;
const MAX_TICKED = 5000;

interface Entry { email: string; name: string | null; repeatOk: boolean; last: RecentContact }

async function loadEntries(blast: NonNullable<Awaited<ReturnType<typeof loadBlast>>>): Promise<{ entries: Entry[]; windowDays: number; exempt: boolean }> {
  const windowDays = repeatWindow(blast.repeatWindowDays);
  if (blast.parentBlastId || windowDays === 0) return { entries: [], windowDays, exempt: !!blast.parentBlastId };
  const recipients = await prisma.recruiterBlastRecipient.findMany({ where: { blastId: blast.id }, orderBy: { id: 'asc' }, select: { email: true, name: true, repeatOk: true } });
  const recent = await recentContacts({ organizationId: blast.organizationId, emails: recipients.map((r) => r.email), days: windowDays, excludeBlastId: blast.id });
  const entries: Entry[] = [];
  for (const r of recipients) {
    const last = recent.get(emailKey(r.email));
    if (last) entries.push({ email: r.email, name: r.name, repeatOk: r.repeatOk, last });
  }
  // The plan checks the address first and only then the repeat guard, so addresses skipped for another reason
  // (invalid, unsubscribed, bounced, typo, no mail server) are not listed here: choosing them would change nothing.
  const [problems, cool] = entries.length
    ? await Promise.all([checkAddresses(entries.map((e) => e.email), blast.workspaceId), coolOffs(blast.organizationId, entries.map((e) => e.email))])
    : [new Map(), new Map()];
  return { entries: entries.filter((e) => isValidEmail(e.email) && !problems.has(e.email.toLowerCase()) && !cool.has(emailKey(e.email))), windowDays, exempt: false };
}

const filterSchema = z.object({
  q: z.string().max(200).optional(),
  show: z.enum(['all', 'skipped', 'included']).optional(),
  olderThanDays: z.number().int().min(0).max(90).optional(),
});

function applyFilter(entries: Entry[], f: z.infer<typeof filterSchema>, now = Date.now()): Entry[] {
  const needle = (f.q ?? '').trim().toLowerCase();
  return entries.filter((e) => {
    if (f.show === 'skipped' && e.repeatOk) return false;
    if (f.show === 'included' && !e.repeatOk) return false;
    if (needle && !e.email.toLowerCase().includes(needle) && !(e.name ?? '').toLowerCase().includes(needle) && !e.last.subject.toLowerCase().includes(needle)) return false;
    // "older than N days": sent at least N days ago (queued-but-not-sent ones never qualify).
    if (f.olderThanDays != null && (e.last.pending || now - e.last.at.getTime() < f.olderThanDays * 86_400_000)) return false;
    return true;
  });
}

const view = (e: Entry) => ({ email: e.email, name: e.name, sendAgain: e.repeatOk, sentAt: e.last.pending ? null : e.last.at.toISOString(), pending: e.last.pending, subject: e.last.subject, source: e.last.source, from: e.last.from, count: e.last.count });

export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastReader();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const url = new URL(req.url);
  const f = filterSchema.parse({ q: url.searchParams.get('q') ?? undefined, show: url.searchParams.get('show') ?? undefined });
  const sort = url.searchParams.get('sort') ?? 'newest';
  const { entries, windowDays, exempt } = await loadEntries(blast);
  const rows = applyFilter(entries, f).sort((a, b) => (sort === 'email' ? a.email.localeCompare(b.email) : sort === 'oldest' ? a.last.at.getTime() - b.last.at.getTime() : b.last.at.getTime() - a.last.at.getTime()));

  if (url.searchParams.get('format') === 'csv') {
    const body = toCsv(['email', 'name', 'send again', 'last emailed', 'subject', 'mailbox', 'source', 'emails in window'], rows.map((e) => [e.email, e.name ?? '', e.repeatOk ? 'yes' : 'no', e.last.pending ? 'queued, not sent yet' : istDateTime(e.last.at), e.last.subject, e.last.from ?? '', e.last.source, e.last.count]));
    return csvResponse(body, 'recently-emailed.csv');
  }

  const rawPage = Math.floor(Number(url.searchParams.get('page') ?? '1'));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.isFinite(rawPage) ? rawPage : 1));
  return NextResponse.json({
    windowDays,
    exempt,
    status: blast.status,
    totals: { recent: entries.length, sendAgain: entries.filter((e) => e.repeatOk).length, skipped: entries.filter((e) => !e.repeatOk).length },
    matching: rows.length,
    page,
    pages,
    perPage: PAGE_SIZE,
    rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(view),
  });
});

const bodySchema = z.object({
  action: z.enum(['include', 'skip', 'remove']),
  scope: z.union([
    z.object({ emails: z.array(z.string().max(320)).min(1).max(MAX_TICKED) }),
    z.object({ all: z.literal(true) }).merge(filterSchema),
  ]),
});

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (blast.status !== 'DRAFT') return NextResponse.json({ error: 'Only a draft can change who gets it.' }, { status: 409 });
  const { action, scope } = bodySchema.parse(await req.json());
  const { entries } = await loadEntries(blast);

  // Only recruiters that really were emailed recently can be acted on, whatever the browser sent.
  const known = new Map(entries.map((e) => [e.email.toLowerCase(), e]));
  const targets = 'emails' in scope
    ? [...new Set(scope.emails.map((e) => e.toLowerCase()))].map((e) => known.get(e)).filter((e): e is Entry => !!e)
    : applyFilter(entries, scope);
  if (!targets.length) return NextResponse.json({ ok: true, changed: 0 });
  const emails = targets.map((t) => t.email);

  let changed = 0;
  for (let i = 0; i < emails.length; i += 5000) {
    const part = emails.slice(i, i + 5000);
    if (action === 'remove') changed += (await prisma.recruiterBlastRecipient.deleteMany({ where: { blastId: blast.id, email: { in: part } } })).count;
    else changed += (await prisma.recruiterBlastRecipient.updateMany({ where: { blastId: blast.id, email: { in: part } }, data: { repeatOk: action === 'include' } })).count;
  }
  forgetPlan(blast.id);
  await audit(session, 'RECRUITER_SEND_REPEAT_REVIEW', {
    targetType: 'RecruiterBlast',
    targetId: blast.id,
    metadata: { action, changed, by: 'emails' in scope ? 'ticked' : 'filter', windowDays: repeatWindow(blast.repeatWindowDays), sample: emails.slice(0, 20) },
  });
  return NextResponse.json({ ok: true, changed });
});
