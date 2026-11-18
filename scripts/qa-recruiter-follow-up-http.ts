/**
 * QA of the Recruiter Follow-up HTTP routes and pages against a running app (laptop standby DB),
 * with throwaway fixtures in their own organization. Nothing is sent: the mailbox has no tokens
 * and the one start is SCHEDULED a year ahead.
 *
 * Usage: BASE_URL=http://localhost:3011 npx tsx scripts/qa-recruiter-follow-up-http.ts
 *        (add SHOT=1 to also save a screenshot of the follow-up page with headless Chrome)
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3011';
const COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass++; console.log(`  PASS ${name}`); } else { fail++; failures.push(name); console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); }
}

async function sessionFor(userId: string) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken, userId, expires: new Date(Date.now() + 3600_000) } });
  return `${COOKIE}=${sessionToken}`;
}
async function call(method: string, path: string, cookie: string | null, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

const stamp = Date.now();
const DOMAIN = `rfu-http-${stamp}.test`;
let orgId = '';

async function cleanup(id: string) {
  const blasts = (await prisma.recruiterBlast.findMany({ where: { organizationId: id }, select: { id: true } })).map((b) => b.id);
  await prisma.recruiterBlastRecipient.deleteMany({ where: { blastId: { in: blasts } } });
  await prisma.recruiterBlastGroup.deleteMany({ where: { blastId: { in: blasts } } });
  await prisma.recruiterBlast.deleteMany({ where: { id: { in: blasts } } });
  const users = (await prisma.user.findMany({ where: { organizationId: id }, select: { id: true } })).map((u) => u.id);
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: id } });
  await prisma.integrationSettings.deleteMany({ where: { organizationId: id } });
  await prisma.emailProviderAccount.deleteMany({ where: { organizationId: id } });
  await prisma.workspace.deleteMany({ where: { organizationId: id } });
  await prisma.user.deleteMany({ where: { organizationId: id } });
  await prisma.organization.delete({ where: { id } });
}

async function main() {
  console.log(`=== Recruiter Follow-up HTTP QA against ${BASE_URL} ===\n`);
  const org = await prisma.organization.create({ data: { name: `RFU HTTP ${stamp}`, allowedDomain: DOMAIN } });
  orgId = org.id;
  const mkUser = (tag: string, role: Role) => prisma.user.create({ data: { organizationId: org.id, googleId: `rfuh-${tag}-${stamp}`, email: `rfuh-${tag}+${stamp}@${DOMAIN}`, name: `RFU ${tag}`, role } });
  const admin = await mkUser('admin', Role.ADMIN);
  const other = await mkUser('other', Role.ADMIN);
  const op = await mkUser('op', Role.OPERATOR);
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: `RFU ws ${stamp}` } });
  const wsOther = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: other.id, name: `RFU other ${stamp}` } });
  await prisma.workspace.create({ data: { organizationId: org.id, ownerId: op.id, name: `RFU op ${stamp}` } });
  const acct = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: admin.id, emailAddress: `one-${stamp}@${DOMAIN}`, displayName: 'one', status: 'CONNECTED' } }); // no tokens: can't send
  void wsOther;

  const base = { organizationId: org.id, workspaceId: ws.id, createdById: admin.id, subject: 'Hiring partners', html: '<p>Hello {{Name}}, original email</p>', plainText: 'Hello', body: 'Hello {{Name}}', columns: ['Name', 'Email'], emailColumn: 'Email', gapSeconds: 3, accountIds: [acct.id] };
  const root = await prisma.recruiterBlast.create({ data: { ...base, name: 'QA root', mode: 'INDIVIDUAL', status: 'COMPLETED', startedAt: new Date(), completedAt: new Date() } });
  const em = (n: string) => `${n}+${stamp}@gmail.com`;
  const people: [string, { opens?: number; replied?: boolean; bounced?: boolean }][] = [
    ['p1', { opens: 2 }], ['p2', { opens: 1 }], ['p3', {}], ['p4', {}], ['p5', { replied: true }], ['p6', { bounced: true }],
  ];
  for (const [i, [n, o]] of people.entries()) {
    const g = await prisma.recruiterBlastGroup.create({ data: { blastId: root.id, seq: i + 1, status: o.bounced ? 'FAILED' : 'SENT', recipientCount: 1, accountId: acct.id, plannedAccountId: acct.id, fromEmail: acct.emailAddress, gmailThreadId: `HT-${n}`, messageIdHeader: `<ht-${n}@x>`, sentAt: new Date() } });
    await prisma.recruiterBlastRecipient.create({ data: { blastId: root.id, email: em(n), name: n.toUpperCase(), data: { Name: n.toUpperCase(), Email: em(n) }, groupId: g.id, status: o.bounced ? 'BOUNCED' : 'SENT', sentAt: new Date(), openCount: o.opens ?? 0, openedAt: o.opens ? new Date() : null, repliedAt: o.replied ? new Date() : null } });
  }
  const draftParent = await prisma.recruiterBlast.create({ data: { ...base, name: 'QA draft parent', mode: 'BCC', toAddress: `p@${DOMAIN}`, status: 'DRAFT' } });
  const adminCookie = await sessionFor(admin.id);
  const otherCookie = await sessionFor(other.id);
  const opCookie = await sessionFor(op.id);

  console.log('Access');
  check('signed out: list is 401', (await call('GET', '/api/recruiter-follow-ups', null)).status === 401);
  check('signed out: create is 401', (await call('POST', '/api/recruiter-follow-ups', null, { parentId: root.id })).status === 401);
  check('operator (not admin): list is 403', (await call('GET', '/api/recruiter-follow-ups', opCookie)).status === 403);
  check('operator: create is 403', (await call('POST', '/api/recruiter-follow-ups', opCookie, { parentId: root.id })).status === 403);
  check('an admin of another workspace cannot follow up this send', [403, 404].includes((await call('POST', '/api/recruiter-follow-ups', otherCookie, { parentId: root.id })).status));
  const pages = await Promise.all(['/recruiter-follow-up'].map((p) => call('GET', p, adminCookie)));
  check('the Recruiter Follow-up page loads for an admin', pages[0]!.status === 200 && /Recruiter Follow-up/.test(pages[0]!.text), pages[0]!.status);

  console.log('\nList');
  const list = await call('GET', '/api/recruiter-follow-ups', adminCookie);
  const src = list.json?.sources?.find((s: any) => s.id === root.id);
  check('a completed send is offered, with sent / replied / opened counts', list.status === 200 && !!src && src.sent === 5 && src.replied === 1 && src.opened === 2, { status: list.status, src });
  check('a draft is not offered as a send to follow up', !list.json?.sources?.some((s: any) => s.id === draftParent.id));
  check('the other workspace sees none of it', !(await call('GET', '/api/recruiter-follow-ups', otherCookie)).json?.sources?.some((s: any) => s.id === root.id));

  console.log('\nCreate');
  check('unknown send → 404', (await call('POST', '/api/recruiter-follow-ups', adminCookie, { parentId: 'nope' })).status === 404);
  check('a draft cannot be followed up → 409', (await call('POST', '/api/recruiter-follow-ups', adminCookie, { parentId: draftParent.id })).status === 409);
  check('missing parentId → 400', (await call('POST', '/api/recruiter-follow-ups', adminCookie, {})).status === 400);
  check('bad segment name → 400', (await call('POST', '/api/recruiter-follow-ups', adminCookie, { parentId: root.id, segments: ['EVERYONE'] })).status === 400);
  check('empty segment list → 400', (await call('POST', '/api/recruiter-follow-ups', adminCookie, { parentId: root.id, segments: [] })).status === 400);
  const created = await call('POST', '/api/recruiter-follow-ups', adminCookie, { parentId: root.id, segments: ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED'] });
  check('create with two segments → 4 recruiters, round 2', created.status === 200 && created.json?.recipients === 4 && created.json?.round === 2, created.json);
  const fid = created.json?.id as string;
  const again = await call('POST', '/api/recruiter-follow-ups', adminCookie, { parentId: root.id });
  check('clicking again reopens the same draft instead of making another', again.status === 200 && again.json?.id === fid && again.json?.reused === true, again.json);
  check('the old single-choice value still works (legacy "audience")', (await call('POST', '/api/recruiter-follow-ups', adminCookie, { parentId: root.id, audience: 'EVERYONE' })).json?.reused === true);
  const draft = await prisma.recruiterBlast.findUnique({ where: { id: fid } });
  check('the draft starts with "Re: <subject>", the parent’s mailbox, an empty body and mode', draft?.subject === 'Re: Hiring partners' && draft.accountIds.includes(acct.id) && draft.body === '' && draft.mode === 'INDIVIDUAL' && draft.parentBlastId === root.id && draft.rootBlastId === root.id && draft.round === 2, draft);
  check('the main Bulk Send list does not show follow-ups', !(await call('GET', '/api/recruiter-blasts', adminCookie)).json?.blasts?.some((b: any) => b.id === fid));
  check('the follow-up list shows the new draft', (await call('GET', '/api/recruiter-follow-ups', adminCookie)).json?.followUps?.some((f: any) => f.id === fid));

  console.log('\nAudience');
  const aud = await call('GET', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie);
  check('counts: opened 2, not opened 2, unknown 0, replied 1, bounced 1, total 6 (bounced never "sent")', same(aud.json?.counts, { NO_REPLY_OPENED: 2, NO_REPLY_UNOPENED: 2, NO_REPLY_UNKNOWN: 0, REPLIED: 1, bounced: 0, total: 5 }) || same(aud.json?.counts, { NO_REPLY_OPENED: 2, NO_REPLY_UNOPENED: 2, NO_REPLY_UNKNOWN: 0, REPLIED: 1, bounced: 1, total: 6 }), aud.json?.counts);
  check('saved segments come back as the two ticked', same(aud.json?.segments, ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED']), aud.json?.segments);
  check('4 selected, every candidate says which segment it is in', aud.json?.selected === 4 && aud.json?.candidates?.every((c: any) => 'segment' in c), aud.json);
  check('search narrows the table', (await call('GET', `/api/recruiter-follow-ups/${fid}/audience?q=p3`, adminCookie)).json?.total === 1);
  check('a page past the end is clamped, not an error', (await call('GET', `/api/recruiter-follow-ups/${fid}/audience?page=999`, adminCookie)).json?.page === 1);
  check('junk page / show values fall back safely', (await call('GET', `/api/recruiter-follow-ups/${fid}/audience?page=abc&show=zzz`, adminCookie)).status === 200);
  check('"selected" filter lists exactly the 4', (await call('GET', `/api/recruiter-follow-ups/${fid}/audience?show=selected`, adminCookie)).json?.total === 4);
  check('another workspace cannot read the audience', [403, 404].includes((await call('GET', `/api/recruiter-follow-ups/${fid}/audience`, otherCookie)).status));
  check('a normal bulk send has no follow-up audience (404)', (await call('GET', `/api/recruiter-follow-ups/${root.id}/audience`, adminCookie)).status === 404);
  const applied = await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'apply', segments: ['REPLIED', 'NO_REPLY_OPENED'] });
  check('apply two other segments → 3', applied.status === 200 && applied.json?.selected === 3, applied.json);
  check('apply nothing → 0 selected', (await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'apply', segments: [] })).json?.selected === 0);
  check('apply with a bad segment → 400', (await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'apply', segments: ['ALL'] })).status === 400);
  check('unknown action → 400', (await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'wipe' })).status === 400);
  check('select with no emails → 400', (await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'select', emails: [], selected: true })).status === 400);
  const sel = await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'select', emails: [em('p3').toUpperCase(), em('p4')], selected: true });
  check('tick two recruiters (any case) → added', sel.status === 200 && sel.json?.added === 2, sel.json);
  check('untick one → removed', (await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'select', emails: [em('p3')], selected: false })).json?.removed === 1);
  check('ticking the bounced recruiter is refused (never included)', (await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'select', emails: [em('p6')], selected: true })).json?.added === 0);
  check('typing a bounced address is a clear 400', (await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'add', text: em('p6') })).status === 400);
  check('text with no address → 400', (await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'add', text: 'hello there' })).status === 400);
  const add = await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'add', text: `new1+${stamp}@gmail.com, new2+${stamp}@gmail.com\n${em('p1')}` });
  check('add: two new addresses and one chain recruiter', add.status === 200 && add.json?.added >= 2 && add.json?.newAddresses === 2, add.json);
  check('the operator cannot change the audience', (await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, opCookie, { action: 'apply', segments: ['REPLIED'] })).status === 403);
  await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'apply', segments: ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED'] });

  console.log('\nEdit, check and start');
  const patch = await call('PATCH', `/api/recruiter-blasts/${fid}`, adminCookie, { subject: 'Re: Hiring partners', body: 'Hello {{Name}}, a quick follow-up on my last email.', onMailboxDown: 'FALLBACK' });
  check('the draft saves the new email and the mailbox-unavailable choice', patch.status === 200 && patch.json?.blast?.onMailboxDown === 'FALLBACK' && /quick follow-up/.test(patch.json?.blast?.html ?? ''), patch.json?.error);
  check('a bad mailbox-unavailable value is refused', (await call('PATCH', `/api/recruiter-blasts/${fid}`, adminCookie, { onMailboxDown: 'MAYBE' })).status === 400);
  const chk = await call('POST', `/api/recruiter-blasts/${fid}/check`, adminCookie, {});
  check('the check works for a follow-up and reports thread counts', chk.status === 200 && chk.json?.followUp && chk.json.followUp.replying + chk.json.followUp.newThread === chk.json.messages, chk.json?.followUp ?? chk.json?.error);
  check('the check does not leak the internal batch list', !('groupSpecs' in (chk.json ?? {})));
  check('the check personalises the preview with the first recruiter', /P1|P2|P3|P4/.test(chk.json?.preview ?? ''), String(chk.json?.preview).slice(0, 200));
  check('the detail shows the earlier email and the round chain', (await call('GET', `/api/recruiter-blasts/${fid}`, adminCookie)).json?.followUp?.parent?.subject === 'Hiring partners');

  await call('PATCH', `/api/recruiter-blasts/${fid}`, adminCookie, { onMailboxDown: 'WAIT', accountIds: [] });
  check('start with no mailbox is refused', (await call('POST', `/api/recruiter-blasts/${fid}/start`, adminCookie, {})).status === 400);
  await call('PATCH', `/api/recruiter-blasts/${fid}`, adminCookie, { accountIds: [acct.id] });
  await call('PATCH', `/api/recruiter-blasts/${fid}`, adminCookie, { body: '' });
  const noBody = await call('POST', `/api/recruiter-blasts/${fid}/start`, adminCookie, {});
  check('start with an empty email is refused with a clear message', noBody.status === 400 && /Write the message/.test(noBody.json?.error ?? ''), noBody.json);
  await call('PATCH', `/api/recruiter-blasts/${fid}`, adminCookie, { body: 'Hello {{Name}}, a quick follow-up.' });
  const past = await call('POST', `/api/recruiter-blasts/${fid}/start`, adminCookie, { scheduledAt: new Date(Date.now() - 3600_000).toISOString() });
  check('a scheduled time in the past is refused', past.status === 400, past.json);

  const when = new Date(Date.now() + 365 * 864e5).toISOString();
  const started = await call('POST', `/api/recruiter-blasts/${fid}/start`, adminCookie, { scheduledAt: when });
  check('start (scheduled a year ahead so nothing goes out) → SCHEDULED, 4 emails', started.status === 200 && started.json?.status === 'SCHEDULED' && started.json?.messages === 4, started.json);
  const groups = await prisma.recruiterBlastGroup.findMany({ where: { blastId: fid }, select: { inReplyToGroupId: true, plannedAccountId: true, recipientCount: true } });
  check('every batch replies to an earlier email and is pinned to its mailbox', groups.length === 4 && groups.every((g) => g.inReplyToGroupId && g.plannedAccountId === acct.id), groups);
  check('a started follow-up can no longer change its audience (409)', (await call('POST', `/api/recruiter-follow-ups/${fid}/audience`, adminCookie, { action: 'apply', segments: ['REPLIED'] })).status === 409);
  check('…or be edited (409)', (await call('PATCH', `/api/recruiter-blasts/${fid}`, adminCookie, { subject: 'x' })).status === 409);
  const blocked = await call('POST', '/api/recruiter-follow-ups', adminCookie, { parentId: root.id });
  check('a second follow-up to the same send is blocked while one is scheduled, pointing at it', blocked.status === 409 && blocked.json?.existingId === fid, blocked.json);
  const pg = await call('GET', `/recruiter-follow-up/${fid}`, adminCookie);
  check('the follow-up page itself loads', pg.status === 200, pg.status);

  if (process.env.SHOT) {
    // A fresh draft on a second chain, so the screenshot shows the editable audience panel.
    await prisma.recruiterBlast.update({ where: { id: fid }, data: { status: 'CANCELLED', completedAt: new Date() } });
    const shotDraft = await call('POST', '/api/recruiter-follow-ups', adminCookie, { parentId: root.id });
    console.log(`\nSCREENSHOT_DRAFT=${shotDraft.json?.id}`);
    console.log(`SCREENSHOT_COOKIE=${adminCookie}`);
    await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 120_000)));
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

main()
  .catch((err) => { fail++; failures.push(`script crashed: ${err instanceof Error ? err.message : String(err)}`); console.error(err); })
  .finally(async () => {
    if (orgId) await cleanup(orgId).catch((e) => console.error('cleanup failed (remove org', orgId, 'by hand):', e.message));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
