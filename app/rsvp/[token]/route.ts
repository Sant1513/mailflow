import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { decodeTrackingToken, type TrackingPayload } from '@/lib/email/tracking';
import { automatedReason } from '@/lib/email/botDetect';
import { isClosed, type RsvpConfig, type RsvpOption } from '@/lib/rsvp/config';
import { loadRsvpContext, recordRsvp, type RsvpContext, type RsvpOutcome } from '@/lib/rsvp/respond';

/**
 * The page behind each RSVP button in an email (public, no sign-in).
 *
 * GET ?a=<option> doesn't record anything by itself: link scanners in corporate and college
 * mail systems open every link in a message, and would otherwise answer for the student. The
 * page submits the answer straight away in a real browser (a one-line script), so for a person
 * it is still one click; a scanner that merely loads the page records nothing. Requests that
 * look automated (lib/email/botDetect.ts) get a "Confirm" button instead of the auto-submit.
 * POST records the answer (and the optional note) and shows the confirmation.
 */
export const dynamic = 'force-dynamic';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(title: string, body: string, accent = '#111827', status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#f6f7f9;color:#1f2937;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{width:100%;max-width:460px;background:#fff;border:1px solid #e5e7eb;border-top:4px solid ${accent};border-radius:12px;padding:28px;box-sizing:border-box}
h1{font-size:20px;margin:0 0 8px}p{margin:8px 0;line-height:1.55;color:#4b5563}.muted{font-size:13px;color:#6b7280}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.btn{display:inline-block;border:0;border-radius:8px;padding:10px 16px;font:600 15px system-ui,Arial,sans-serif;cursor:pointer;text-decoration:none}
.ghost{background:#f3f4f6;color:#111827}
textarea{width:100%;box-sizing:border-box;min-height:80px;border:1px solid #d1d5db;border-radius:8px;padding:8px;font:14px system-ui,Arial,sans-serif;margin-top:6px;background:inherit;color:inherit}
label{display:block;margin-top:16px;font-size:14px;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#111827;color:#f3f4f6}main{background:#1f2937;border-color:#374151}p{color:#d1d5db}.muted{color:#9ca3af}.ghost{background:#374151;color:#f3f4f6}textarea{border-color:#4b5563}}
</style></head><body><main>${body}</main></body></html>`;
  return new NextResponse(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

const optionButton = (o: RsvpOption, extraClass = '') =>
  `<button class="btn ${extraClass}" name="answer" value="${esc(o.key)}" style="background:${o.background};color:${o.textColor}">${o.emoji ? `${esc(o.emoji)} ` : ''}${esc(o.label)}</button>`;

function changeButtons(config: RsvpConfig, current: RsvpOption | null) {
  if (!config.allowChange || isClosed(config)) return '';
  const others = config.options.filter((o) => o.key !== current?.key);
  if (!others.length) return '';
  return `<form method="post" class="row" aria-label="Change your answer"><span class="muted" style="width:100%">Changed your mind?</span>${others.map((o) => optionButton(o)).join('')}</form>`;
}

function resultPage(ctx: RsvpContext, outcome: RsvpOutcome): NextResponse {
  const { config } = ctx;
  if (outcome.status === 'invalid') return page('Not available', '<h1>This answer is not available</h1><p>Please use the buttons in the email.</p>', '#6b7280', 400);
  if (outcome.status === 'closed') {
    return page('Responses closed', `<h1>Responses are closed</h1><p>${esc(config.closedMessage)}</p>${outcome.current ? `<p class="muted">Your answer on record: <b>${esc(outcome.current.label)}</b></p>` : ''}`, '#6b7280');
  }
  if (outcome.status === 'full') {
    return page('Fully booked', `<h1>${esc(outcome.option?.label ?? 'This option')} is full</h1><p>${esc(config.fullMessage)}</p>${outcome.current ? `<p class="muted">Your answer on record: <b>${esc(outcome.current.label)}</b></p>` : ''}${changeButtons(config, outcome.current)}`, '#d97706');
  }
  if (outcome.status === 'locked') {
    return page('Already answered', `<h1>You have already answered</h1><p>Your answer: <b>${esc(outcome.current?.label ?? '')}</b>. Answers can't be changed for this one — reply to the email if something has changed.</p>`, outcome.current?.background);
  }
  const o = (outcome as Extract<RsvpOutcome, { status: 'recorded' | 'unchanged' }>).option;
  const noteForm = o.askNote
    ? `<form method="post"><input type="hidden" name="answer" value="${esc(o.key)}"><label for="note">${esc(o.notePrompt || 'Anything to add? (optional)')}</label><textarea id="note" name="note" maxlength="2000">${esc(ctx.current?.answer === o.key ? ctx.current?.note ?? '' : '')}</textarea><div class="row"><button class="btn" style="background:${o.background};color:${o.textColor}">Send</button></div></form>`
    : '';
  return page(o.confirmTitle || 'Thank you', `<h1>${o.emoji ? `${esc(o.emoji)} ` : ''}${esc(o.confirmTitle || 'Thank you')}</h1><p>${esc(o.confirmMessage)}</p><p class="muted">Your answer: <b>${esc(o.label)}</b></p>${noteForm}${changeButtons(config, o)}`, o.background);
}

async function contextFor(token: string): Promise<{ payload: TrackingPayload; ctx: RsvpContext } | NextResponse> {
  const payload = decodeTrackingToken(token);
  if (!payload) return page('Link not valid', '<h1>This link is not valid</h1><p>Please use the buttons in the email you received.</p>', '#6b7280', 400);
  const ctx = await loadRsvpContext(payload);
  if (!ctx) return page('No longer active', '<h1>This RSVP is no longer active</h1><p>Reply to the email if you need help.</p>', '#6b7280', 404);
  return { payload, ctx };
}

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const found = await contextFor(params.token);
  if (found instanceof NextResponse) return found;
  const { payload, ctx } = found;
  const option = ctx.config.options.find((o) => o.key === req.nextUrl.searchParams.get('a'));
  const current = ctx.current ? ctx.config.options.find((o) => o.key === ctx.current!.answer) ?? null : null;

  if (!option) {
    // Opened without an answer: show the question with the buttons.
    const title = ctx.config.question || ctx.campaign.name;
    return page(title, `<h1>${esc(title)}</h1>${current ? `<p class="muted">Your answer on record: <b>${esc(current.label)}</b></p>` : ''}${isClosed(ctx.config) ? `<p>${esc(ctx.config.closedMessage)}</p>` : `<form method="post" class="row">${ctx.config.options.map((o) => optionButton(o)).join('')}</form>`}`);
  }
  if (isClosed(ctx.config)) return resultPage(ctx, { status: 'closed', option, current });

  const job = await prisma.emailJob.findUnique({ where: { id: payload.emailJobId }, select: { sentAt: true } });
  const looksAutomated = !!automatedReason({ type: 'CLICK', userAgent: req.headers.get('user-agent'), sentAt: job?.sentAt ?? null, at: new Date() });
  const autoSubmit = looksAutomated ? '' : `<script>document.getElementById('rsvp').submit()</script>`;
  return page(
    'Confirm your answer',
    `<h1>${esc(ctx.config.question || 'Your answer')}</h1><p>${looksAutomated ? 'Please confirm your answer:' : 'Saving your answer…'}</p><form id="rsvp" method="post" class="row"><input type="hidden" name="answer" value="${esc(option.key)}"><button class="btn" style="background:${option.background};color:${option.textColor}">${option.emoji ? `${esc(option.emoji)} ` : ''}Confirm: ${esc(option.label)}</button></form>${autoSubmit}`,
    option.background,
  );
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const found = await contextFor(params.token);
  if (found instanceof NextResponse) return found;
  const { payload, ctx } = found;
  const form = await req.formData().catch(() => null);
  const answer = String(form?.get('answer') ?? '');
  const note = form?.get('note');
  const outcome = await recordRsvp(ctx, payload, {
    answer,
    note: typeof note === 'string' ? note : null,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent'),
  });
  // Show the latest state (e.g. the note just saved) on the result page.
  if (outcome.status === 'recorded' || outcome.status === 'unchanged') {
    ctx.current = { answer: outcome.option.key, note: typeof note === 'string' && note.trim() ? note.trim() : ctx.current?.note ?? null };
  }
  return resultPage(ctx, outcome);
}
