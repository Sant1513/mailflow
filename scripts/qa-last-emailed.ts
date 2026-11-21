/**
 * QA of "last emailed" and the "recently emailed" filter in Contacts and Data, the cool-off editor, and the daily
 * over-mailed section, against a running app (laptop standby DB), with throwaway fixtures in their own organization.
 * Includes a 100,000-record dataset for speed. Nothing is sent.
 *
 * Usage: BASE_URL=http://localhost:3021 npx tsx scripts/qa-last-emailed.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { ColumnType, Role } from '@prisma/client';
import { prisma } from '../lib/db/client';
import { collectOvermailed } from '../lib/digest/overmailed';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3021';
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
const DAY = 86_400_000;
const DOMAIN = `qle-${stamp}.test`;
const orgIds: string[] = [];
const g = (n: string) => `${n}${stamp}@gmail.com`;

async function cleanup(id: string) {
  const blasts = (await prisma.recruiterBlast.findMany({ where: { organizationId: id }, select: { id: true } })).map((b) => b.id);
  await prisma.recruiterBlastRecipient.deleteMany({ where: { blastId: { in: blasts } } });
  await prisma.recruiterBlastGroup.deleteMany({ where: { blastId: { in: blasts } } });
  await prisma.recruiterBlast.deleteMany({ where: { id: { in: blasts } } });
  const datasets = (await prisma.dataset.findMany({ where: { organizationId: id }, select: { id: true } })).map((d) => d.id);
  await prisma.record.deleteMany({ where: { datasetId: { in: datasets } } });
  await prisma.datasetColumn.deleteMany({ where: { datasetId: { in: datasets } } });
  await prisma.dataset.deleteMany({ where: { id: { in: datasets } } });
  const users = (await prisma.user.findMany({ where: { organizationId: id }, select: { id: true } })).map((u) => u.id);
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: id } });
  await prisma.contact.deleteMany({ where: { organizationId: id } });
  await prisma.emailProviderAccount.deleteMany({ where: { organizationId: id } });
  await prisma.workspace.deleteMany({ where: { organizationId: id } });
  await prisma.user.deleteMany({ where: { organizationId: id } });
  await prisma.organization.delete({ where: { id } });
}

async function main() {
  console.log(`=== Last emailed, filters, cool-off and digest QA against ${BASE_URL} ===\n`);
  const org = await prisma.organization.create({ data: { name: `QLE ${stamp}`, allowedDomain: DOMAIN } });
  orgIds.push(org.id);
  const admin = await prisma.user.create({ data: { organizationId: org.id, googleId: `qle-a-${stamp}`, email: `qle-a+${stamp}@${DOMAIN}`, name: 'QLE admin', role: Role.ADMIN } });
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: `QLE ws ${stamp}` } });
  const acct = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: admin.id, emailAddress: `box-${stamp}@${DOMAIN}`, displayName: 'box', status: 'CONNECTED' } });
  const cookie = await sessionFor(admin.id);

  // History: one person emailed 3 days ago (stored with dots), one 20 days ago, one never.
  const base = { organizationId: org.id, workspaceId: ws.id, createdById: admin.id, html: '<p>x</p>', plainText: 'x', body: 'x', columns: [], emailColumn: null, gapSeconds: 3, accountIds: [acct.id] };
  const past = await prisma.recruiterBlast.create({ data: { ...base, name: 'Past drive', subject: 'Hiring drive – Dec', mode: 'INDIVIDUAL', status: 'COMPLETED' } });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: past.id, email: `re.cent${stamp}@gmail.com`, status: 'SENT', sentAt: new Date(Date.now() - 3 * DAY) } });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: past.id, email: g('old'), status: 'SENT', sentAt: new Date(Date.now() - 20 * DAY) } });

  console.log('Contacts');
  const mkContact = (email: string, name: string) => prisma.contact.create({ data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: email, name } });
  const cRecent = await mkContact(g('recent'), 'Recent'); // alias of re.cent
  const cOld = await mkContact(g('old'), 'Old');
  const cNever = await mkContact(g('never'), 'Never');
  const all = await call('GET', '/api/contacts', cookie);
  const byName = new Map<string, any>((all.json?.contacts ?? []).map((c: any) => [c.name, c]));
  check('the list shows when each contact was last emailed (alias-matched), with the subject', all.status === 200 && byName.get('Recent')?.lastEmailed?.subject === 'Hiring drive – Dec' && !!byName.get('Old')?.lastEmailed && !byName.get('Never')?.lastEmailed, { s: all.status, r: byName.get('Recent')?.lastEmailed, n: byName.get('Never')?.lastEmailed });
  const within = await call('GET', '/api/contacts?emailed=within&emailedDays=10', cookie);
  check('"emailed in the last 10 days" finds only the recent one, with the right count', (within.json?.contacts ?? []).map((c: any) => c.name).join() === 'Recent' && within.json?.total === 1, { names: (within.json?.contacts ?? []).map((c: any) => c.name), t: within.json?.total });
  const not = await call('GET', '/api/contacts?emailed=not&emailedDays=10', cookie);
  check('"not emailed in the last 10 days" finds the other two', (not.json?.contacts ?? []).map((c: any) => c.name).sort().join() === 'Never,Old' && not.json?.total === 2, { names: (not.json?.contacts ?? []).map((c: any) => c.name), t: not.json?.total });
  const wide = await call('GET', '/api/contacts?emailed=within&emailedDays=30', cookie);
  check('a 30-day window also finds the one emailed 20 days ago', wide.json?.total === 2, wide.json?.total);
  const withSearch = await call('GET', `/api/contacts?emailed=not&emailedDays=10&q=${encodeURIComponent('never')}`, cookie);
  check('the filter combines with search', withSearch.json?.total === 1 && withSearch.json?.contacts?.[0]?.name === 'Never', withSearch.json?.total);
  check('a bad filter value is ignored, not an error', (await call('GET', '/api/contacts?emailed=banana&emailedDays=abc', cookie)).status === 200);

  console.log('\nCool-off editor');
  const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
  check('signed out is refused', (await call('PATCH', `/api/contacts/${cNever.id}`, null, { doNotContactUntil: day(5) })).status === 401);
  const set = await call('PATCH', `/api/contacts/${cNever.id}`, cookie, { doNotContactUntil: day(5), coolOffNote: '  On leave  ' });
  check('set a cool-off with a note', set.status === 200 && !!set.json?.contact?.doNotContactUntil && set.json?.contact?.coolOffNote === 'On leave', set.json);
  const stored = await prisma.contact.findUnique({ where: { id: cNever.id }, select: { doNotContactUntil: true, coolOffNote: true } });
  check('it is saved, and bulk sends see it', !!stored?.doNotContactUntil && stored.doNotContactUntil.getTime() > Date.now());
  check('a nonsense date is refused (400)', (await call('PATCH', `/api/contacts/${cNever.id}`, cookie, { doNotContactUntil: 'soon' })).status === 400);
  check('a date more than 2 years ahead is refused (400)', (await call('PATCH', `/api/contacts/${cNever.id}`, cookie, { doNotContactUntil: day(900) })).status === 400);
  check('an over-long note is refused (400)', (await call('PATCH', `/api/contacts/${cNever.id}`, cookie, { doNotContactUntil: day(5), coolOffNote: 'x'.repeat(500) })).status === 400);
  const listed = await call('GET', '/api/contacts', cookie);
  check('the list carries the cool-off for the badge', !!(listed.json?.contacts ?? []).find((c: any) => c.name === 'Never')?.doNotContactUntil);
  const cleared = await call('PATCH', `/api/contacts/${cNever.id}`, cookie, { doNotContactUntil: null });
  const after = await prisma.contact.findUnique({ where: { id: cNever.id }, select: { doNotContactUntil: true, coolOffNote: true } });
  check('clearing removes the date and the note', cleared.status === 200 && after?.doNotContactUntil === null && after?.coolOffNote === null, after);
  check('the change is in the audit log', (await prisma.auditLog.count({ where: { organizationId: org.id, targetId: cNever.id } })) >= 2);
  void cRecent; void cOld;

  console.log('\nData');
  const ds = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: 'QLE recruiters' } });
  await prisma.datasetColumn.createMany({ data: [{ datasetId: ds.id, key: 'name', label: 'Name', type: ColumnType.TEXT, order: 0 }, { datasetId: ds.id, key: 'email', label: 'Email', type: ColumnType.EMAIL, order: 1 }] });
  const rec = (n: string, email: string) => ({ datasetId: ds.id, data: { name: n, email } });
  await prisma.record.createMany({ data: [rec('Recent', `Re.Cent${stamp}+x@gmail.com`), rec('Old', g('old')), rec('Never', g('never')), rec('Blank', '')] });
  const d = await call('GET', `/api/datasets/${ds.id}`, cookie);
  const rows = d.json?.records ?? [];
  const find = (name: string) => rows.find((r: any) => r.data?.name === name);
  check('the dataset knows its email column and the last-emailed lookup', d.status === 200 && d.json?.emailColumnKey === 'email' && Object.values(d.json?.lastEmailed ?? {}).filter(Boolean).length === 2, { s: d.status, k: d.json?.emailColumnKey, l: d.json?.lastEmailed });
  check('the recent record is matched by alias and carries its subject', find('Recent') && d.json.lastEmailed[find('Recent').id]?.subject === 'Hiring drive – Dec', d.json?.lastEmailed);
  const dWithin = await call('GET', `/api/datasets/${ds.id}?emailed=within&emailedDays=10`, cookie);
  check('Data: "emailed in the last 10 days" shows only that record, count exact', dWithin.json?.records?.length === 1 && dWithin.json?.records?.[0]?.data?.name === 'Recent' && dWithin.json?.matched === 1, { n: dWithin.json?.records?.length, m: dWithin.json?.matched });
  const dNot = await call('GET', `/api/datasets/${ds.id}?emailed=not&emailedDays=10`, cookie);
  check('Data: "not emailed" shows the other three (a blank email counts as not emailed)', dNot.json?.matched === 3, dNot.json?.matched);
  const noEmail = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: 'QLE no email' } });
  await prisma.datasetColumn.create({ data: { datasetId: noEmail.id, key: 'name', label: 'Name', type: ColumnType.TEXT, order: 0 } });
  await prisma.record.create({ data: { datasetId: noEmail.id, data: { name: 'x' } } });
  const dn = await call('GET', `/api/datasets/${noEmail.id}?emailed=within&emailedDays=10`, cookie);
  check('a dataset without an email column ignores the filter and shows no last-emailed', dn.status === 200 && dn.json?.emailColumnKey == null && dn.json?.matched === 1, { s: dn.status, k: dn.json?.emailColumnKey, m: dn.json?.matched });

  console.log('\nA big dataset (100,000 records)');
  const big = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: 'QLE big' } });
  await prisma.datasetColumn.createMany({ data: [{ datasetId: big.id, key: 'name', label: 'Name', type: ColumnType.TEXT, order: 0 }, { datasetId: big.id, key: 'email', label: 'Email', type: ColumnType.EMAIL, order: 1 }] });
  for (let i = 0; i < 100_000; i += 5000) await prisma.record.createMany({ data: Array.from({ length: 5000 }, (_, k) => ({ datasetId: big.id, data: { name: `P${i + k}`, email: `big${i + k}+${stamp}@gmail.com` } })) });
  // The first 25 (big0…big24) were emailed 2 days ago, spelled with dots and a +tag: the same inbox as the records.
  await prisma.recruiterBlastRecipient.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ blastId: past.id, email: `b.i.g${i}+q${stamp}@gmail.com`, status: 'SENT', sentAt: new Date(Date.now() - 2 * DAY) })) });
  const t0 = Date.now();
  const bigAll = await call('GET', `/api/datasets/${big.id}`, cookie);
  const tAll = Date.now() - t0;
  check(`plain browsing stays fast (${tAll} ms) and counts 100,000`, bigAll.status === 200 && bigAll.json?.total === 100_000 && tAll < 8000, { s: bigAll.status, t: bigAll.json?.total, tAll });
  const t1 = Date.now();
  const bigWithin = await call('GET', `/api/datasets/${big.id}?emailed=within&emailedDays=10`, cookie);
  const tW = Date.now() - t1;
  check(`the filter on 100,000 records answers in ${tW} ms (under 10 s) with the exact 25`, bigWithin.status === 200 && bigWithin.json?.matched === 25 && tW < 10_000, { s: bigWithin.status, m: bigWithin.json?.matched, tW, err: bigWithin.json?.error });
  const t2 = Date.now();
  const bigNot = await call('GET', `/api/datasets/${big.id}?emailed=not&emailedDays=10`, cookie);
  check(`"not emailed" on 100,000 answers in ${Date.now() - t2} ms with 99,975`, bigNot.status === 200 && bigNot.json?.matched === 99_975, { m: bigNot.json?.matched });

  console.log('\nThe daily over-mailed section');
  const skip = async (name: string, rows: [string, string][], startedAgoDays = 1, parent: string | null = null) => {
    const b = await prisma.recruiterBlast.create({ data: { ...base, name, subject: name, mode: 'INDIVIDUAL', status: 'COMPLETED', startedAt: new Date(Date.now() - startedAgoDays * DAY), parentBlastId: parent, rootBlastId: parent } });
    for (const [email, kind] of rows) await prisma.recruiterBlastRecipient.create({ data: { blastId: b.id, email, status: 'SKIPPED', skipKind: kind, skipReason: 'Emailed 2 days ago (x): “s”.' } });
  };
  await skip('S1', [[`ov.er${stamp}@gmail.com`, 'RECENTLY_EMAILED'], [g('twice'), 'RECENTLY_EMAILED'], [g('cooly'), 'COOL_OFF']], 1);
  await skip('S2', [[`over${stamp}+a@gmail.com`, 'RECENTLY_EMAILED'], [g('twice'), 'RECENTLY_EMAILED']], 2);
  await skip('S3', [[`OVER${stamp}@gmail.com`, 'RECENTLY_EMAILED']], 3);
  for (const [i, ago] of [40, 45, 50].entries()) await skip(`S4 old ${i}`, [[g('stale'), 'RECENTLY_EMAILED']], ago); // three skips, but all outside 30 days
  await skip('Follow-up', [[g('fu'), 'RECENTLY_EMAILED']], 1, past.id); // follow-ups are not counted
  const over = await collectOvermailed(org.id);
  check('one person skipped in 3 different sends (three spellings of one inbox) is listed once', over.total === 1 && over.people.length === 1 && over.people[0]!.skippedSends === 3, over);
  check('twice is not enough, old and follow-up skips do not count', !over.people.some((p) => /twice|stale|fu/.test(p.email)));
  check('the cool-off count is separate (1 person in the last 7 days)', over.coolOff === 1, over.coolOff);
  const emptyOrg = await prisma.organization.create({ data: { name: `QLE empty ${stamp}`, allowedDomain: `e-${DOMAIN}` } });
  orgIds.push(emptyOrg.id);
  const empty = await collectOvermailed(emptyOrg.id);
  check('an organisation with nothing to show returns an empty section', empty.total === 0 && empty.people.length === 0 && empty.coolOff === 0, empty);

  if (process.env.SHOT_FILE) {
    // Held open for the browser check: a super admin, a send with recently emailed and cool-off recruiters, the contacts and the dataset above.
    const sup = await prisma.user.create({ data: { organizationId: org.id, googleId: `qle-s-${stamp}`, email: `qle-s+${stamp}@${DOMAIN}`, name: 'QLE super', role: Role.SUPER_ADMIN } });
    const supCookie = await sessionFor(sup.id);
    await prisma.contact.update({ where: { id: cNever.id }, data: { doNotContactUntil: new Date(Date.now() + 6 * DAY), coolOffNote: 'On leave until December' } });
    const shot = await prisma.recruiterBlast.create({ data: { ...base, html: '<p>Hello</p>', plainText: 'Hello', body: 'Hello', name: 'QLE screenshot send', subject: 'Hiring partners', mode: 'INDIVIDUAL', status: 'DRAFT' } });
    for (const e of [g('recent'), g('never'), g('old'), g('fresh1'), g('fresh2')]) await prisma.recruiterBlastRecipient.create({ data: { blastId: shot.id, email: e } });
    (await import('node:fs')).writeFileSync(process.env.SHOT_FILE, JSON.stringify({ cookie, superCookie: supCookie, draftId: shot.id, datasetId: ds.id, contactId: cNever.id, recentContactId: cRecent.id }));
    await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 300_000)));
  }
}

main()
  .catch((err) => { fail++; failures.push(`script crashed: ${err instanceof Error ? err.message : String(err)}`); console.error(err); })
  .finally(async () => {
    for (const id of orgIds) await cleanup(id).catch((e) => console.error('cleanup failed (remove org', id, 'by hand):', e.message));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
