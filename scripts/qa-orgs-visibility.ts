/**
 * Real check (laptop standby + running dev server): who sees Recruiter Bulk Send emails and recruiters.
 * Fixtures: organisations A and B, an ADMIN in each, a SUPER_ADMIN and an OPERATOR in A; a completed send per organisation.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-orgs-visibility.ts
 */
import crypto from 'node:crypto';
import puppeteer, { type Page } from 'puppeteer-core';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)?.slice(0, 400)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const org = await prisma.organization.findFirstOrThrow({ where: { allowedDomain: 'masaischool.com' } });
  const tag = `ov${Date.now()}`;
  const unitA = await prisma.orgUnit.create({ data: { organizationId: org.id, name: `QA Org A ${tag}`, domains: [] } });
  const unitB = await prisma.orgUnit.create({ data: { organizationId: org.id, name: `QA Org B ${tag}`, domains: [] } });
  const mk = async (label: string, role: Role, unit: { id: string }) => {
    const u = await prisma.user.create({ data: { organizationId: org.id, orgUnitId: unit.id, googleId: `qa-ov-${label}-${tag}`, email: `qa-ov-${label}-${tag}@masaischool.com`, name: `QA ${label} ${tag}`, role } });
    const w = await prisma.workspace.create({ data: { organizationId: org.id, orgUnitId: unit.id, ownerId: u.id, name: `QA ${label} ws` } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
    return { u, w, token };
  };
  const sa = await mk('SuperA', Role.SUPER_ADMIN, unitA);
  const adA = await mk('AdminA', Role.ADMIN, unitA);
  const adB = await mk('AdminB', Role.ADMIN, unitB);
  const op = await mk('OperatorA', Role.OPERATOR, unitA);

  const tA = new Date(Date.now() - 3 * 3600_000), tB = new Date(Date.now() - 1 * 3600_000);
  const mkBlast = (who: typeof adA, unit: { id: string }, name: string) => prisma.recruiterBlast.create({ data: { organizationId: org.id, orgUnitId: unit.id, workspaceId: who.w.id, createdById: who.u.id, name, subject: `QA subject ${tag}`, html: '<p>x</p>', plainText: 'x', body: 'x', status: 'COMPLETED', startedAt: tA, completedAt: tB } });
  const blastA = await mkBlast(adA, unitA, `QA-ORGVIS-A-${tag}`);
  const blastB = await mkBlast(adB, unitB, `QA-ORGVIS-B-${tag}`);
  const E = { shared: `shared.${tag}@gmail.com`, onlyA: `onlya.${tag}@gmail.com`, onlyB: `onlyb.${tag}@gmail.com`, under: `a_b${tag}@gmail.com`, other: `axb${tag}@gmail.com` };
  const rec = (blastId: string, email: string, sentAt: Date) => ({ blastId, email, name: null, status: 'SENT', sentAt });
  await prisma.recruiterBlastRecipient.createMany({ data: [
    rec(blastA.id, E.shared, tA), rec(blastA.id, E.onlyA, tA), rec(blastA.id, E.under, tA), rec(blastA.id, E.other, tA),
    rec(blastB.id, E.shared, tB), rec(blastB.id, E.onlyB, tB),
  ] });

  const get = async (path: string, token: string) => { const r = await fetch(BASE + path, { headers: { cookie: `next-auth.session-token=${token}` } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  const emails = (rows: any[]) => rows.map((r) => r.email).sort();
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    // ---------------- History API ----------------
    const q = `q=${tag}`;
    const hSA = await get(`/api/history?direction=recruiter&${q}`, sa.token);
    check('Super Admin: both organisations’ rows (6)', hSA.body?.total === 6 && hSA.body.canSee === true, hSA.body?.total);
    const sh = hSA.body?.items?.find((i: any) => i.email === E.onlyB);
    check('…each row carries sentBy and orgName', sh?.blast.sentBy === adB.u.name && sh?.blast.orgName === unitB.name, sh?.blast);
    check('…filters.orgs lists every organisation', [unitA.id, unitB.id].every((id) => hSA.body.filters.orgs.some((o: any) => o.id === id)), hSA.body?.filters?.orgs);
    check('…filters.senders lists both admins', [adA.u.id, adB.u.id].every((id) => hSA.body.filters.senders.some((s: any) => s.id === id)), hSA.body?.filters?.senders);
    const hOrgB = await get(`/api/history?direction=recruiter&${q}&org=${unitB.id}`, sa.token);
    check('?org=B narrows to B’s 2 rows', hOrgB.body?.total === 2 && hOrgB.body.items.every((i: any) => i.blast.orgUnitId === unitB.id), hOrgB.body?.total);
    const hSender = await get(`/api/history?direction=recruiter&${q}&sender=${adA.u.id}`, sa.token);
    check('?sender=adminA narrows to A’s 4 rows', hSender.body?.total === 4 && hSender.body.items.every((i: any) => i.blast.createdById === adA.u.id), hSender.body?.total);
    const hBoth = await get(`/api/history?direction=recruiter&${q}&org=${unitB.id}&sender=${adA.u.id}`, sa.token);
    check('?org=B&sender=adminA (no overlap) is empty', hBoth.body?.total === 0, hBoth.body?.total);

    const hA = await get(`/api/history?direction=recruiter&${q}&org=${unitB.id}`, adA.token);
    check('Admin A sees only A’s rows even when ?org=B is passed', hA.body?.total === 4 && hA.body.items.every((i: any) => i.blast.orgUnitId === unitA.id), hA.body?.total);
    check('…and filters.orgs is empty', Array.isArray(hA.body?.filters?.orgs) && hA.body.filters.orgs.length === 0, hA.body?.filters);
    const hAs = await get(`/api/history?direction=recruiter&${q}&sender=${adB.u.id}`, adA.token);
    check('Admin A passing ?sender=adminB (other org) still sees nothing of B', hAs.body?.total === 0, hAs.body?.total);
    const hB = await get(`/api/history?direction=recruiter&${q}`, adB.token);
    check('Admin B sees only B’s 2 rows', hB.body?.total === 2 && hB.body.items.every((i: any) => i.blast.orgUnitId === unitB.id), hB.body?.total);
    const hOp = await get(`/api/history?direction=recruiter&${q}`, op.token);
    check('Operator: canSee=false and no rows', hOp.body?.canSee === false && hOp.body.total === 0 && hOp.body.items.length === 0, hOp.body);

    const sSA = await get(`/api/history?direction=sent&${q}`, sa.token);
    const sAdA = await get(`/api/history?direction=sent&${q}`, adA.token);
    const sAdB = await get(`/api/history?direction=sent&${q}`, adB.token);
    const sOp = await get(`/api/history?direction=sent&${q}`, op.token);
    check('sent-tab recruiterMatches respects scope (SA 6, A 4, B 2, operator 0)', sSA.body?.recruiterMatches === 6 && sAdA.body?.recruiterMatches === 4 && sAdB.body?.recruiterMatches === 2 && sOp.body?.recruiterMatches === 0, [sSA.body?.recruiterMatches, sAdA.body?.recruiterMatches, sAdB.body?.recruiterMatches, sOp.body?.recruiterMatches]);

    // ---------------- Recruiters API ----------------
    const rSA = await get(`/api/recruiters?${q}`, sa.token);
    check('Super Admin: 5 distinct addresses across organisations', rSA.status === 200 && rSA.body.total === 5 && emails(rSA.body.recruiters).join() === Object.values(E).map((e) => e.toLowerCase()).sort().join(), emails(rSA.body?.recruiters ?? []));
    const shared = rSA.body?.recruiters?.find((r: any) => r.email === E.shared);
    check('…an address emailed by both is ONE line: sends 2, blasts 2, lastSentAt = the later one', shared?.sends === 2 && shared?.blasts === 2 && new Date(shared.lastSentAt).getTime() === tB.getTime(), shared);
    const rA = await get(`/api/recruiters?${q}&org=${unitB.id}`, adA.token);
    const sharedA = rA.body?.recruiters?.find((r: any) => r.email === E.shared);
    check('Admin A: only own organisation (4 addresses, shared counted once, ?org=B ignored)', rA.body?.total === 4 && !emails(rA.body.recruiters).includes(E.onlyB) && sharedA?.sends === 1 && sharedA?.blasts === 1, rA.body);
    const rB = await get(`/api/recruiters?${q}`, adB.token);
    check('Admin B: only B’s 2 addresses', rB.body?.total === 2 && emails(rB.body.recruiters).join() === [E.shared, E.onlyB].sort().join(), emails(rB.body?.recruiters ?? []));
    const rOp = await get(`/api/recruiters?${q}`, op.token);
    check('Operator gets 403', rOp.status === 403, rOp.status);
    const rOrg = await get(`/api/recruiters?${q}&org=${unitB.id}`, sa.token);
    check('Super Admin ?org=B narrows to 2', rOrg.body?.total === 2, rOrg.body?.total);

    const rUnder = await get(`/api/recruiters?q=${encodeURIComponent(`a_b${tag}`)}`, sa.token);
    check('"_" is a literal, not a wildcard (a_b… does not match axb…)', rUnder.body?.total === 1 && rUnder.body.recruiters[0].email === E.under, emails(rUnder.body?.recruiters ?? []));
    const rPct = await get(`/api/recruiters?q=${encodeURIComponent(`%${tag}`)}`, sa.token);
    check('"%" is a literal, not a wildcard (no leak)', rPct.status === 200 && rPct.body.total === 0, rPct.body?.total);
    const rPct2 = await get(`/api/recruiters?q=${encodeURIComponent('%')}`, sa.token);
    check('a lone "%" does not list everyone', rPct2.body?.total === 0 || !(rPct2.body?.recruiters ?? []).some((r: any) => r.email.includes(tag)), rPct2.body?.total);
    const rNone = await get(`/api/recruiters?q=${encodeURIComponent(`nobody${tag}`)}`, sa.token);
    check('a search with no match is empty', rNone.body?.total === 0 && rNone.body.recruiters.length === 0);

    const p1 = await get(`/api/recruiters?${q}&pageSize=2&page=1`, sa.token);
    const p2 = await get(`/api/recruiters?${q}&pageSize=2&page=2`, sa.token);
    const p3 = await get(`/api/recruiters?${q}&pageSize=2&page=3`, sa.token);
    const all = [...p1.body.recruiters, ...p2.body.recruiters, ...p3.body.recruiters];
    check('paging: total 5, pages 3, sizes 2/2/1, no repeats, nothing lost', p1.body.total === 5 && p1.body.pages === 3 && p1.body.pageSize === 2 && p1.body.recruiters.length === 2 && p2.body.recruiters.length === 2 && p3.body.recruiters.length === 1 && new Set(all.map((r: any) => r.email)).size === 5, [p1.body.pages, all.length]);
    check('paging: ordered by last emailed (newest first)', p1.body.recruiters[0].email === E.shared || new Date(p1.body.recruiters[0].lastSentAt) >= new Date(p1.body.recruiters[1].lastSentAt), p1.body.recruiters.map((r: any) => r.lastSentAt));

    // ---------------- UI ----------------
    const page: Page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    const as = async (token: string) => { await page.deleteCookie(...(await page.cookies())); await page.setCookie({ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/' }); };
    const buttons = () => page.evaluate(() => [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()));
    const openHistory = async (token: string) => {
      await as(token);
      const probe = page.waitForResponse((r) => r.url().includes('direction=recruiter&pageSize=1'), { timeout: 120_000 });
      await page.goto(`${BASE}/history`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await probe;
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim().toLowerCase() === 'sent'), { timeout: 60_000 });
      await sleep(800);
    };

    await openHistory(sa.token);
    check('History (Super Admin): shows the Recruiter Bulk Send tab', (await buttons()).includes('Recruiter Bulk Send'));
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Recruiter Bulk Send') as HTMLElement).click());
    await page.waitForSelector('input[placeholder^="Search address, name, send name"]', { timeout: 30_000 });
    await page.type('input[placeholder^="Search address, name, send name"]', tag);
    await page.waitForFunction((a: string) => document.body.innerText.includes(a), { timeout: 60_000 }, E.onlyB);
    await page.waitForSelector('[data-recruiter-filters]', { timeout: 15_000 }).catch(() => undefined);
    const f = await page.evaluate(() => ({ org: !!document.querySelector('[data-recruiter-filters] select[aria-label="Organisation"]'), sender: !!document.querySelector('[data-recruiter-filters] select[aria-label="Sent by"]'), text: document.body.innerText }));
    check('History (Super Admin): organisation and sender dropdowns are shown', f.org && f.sender, f);
    check('History (Super Admin): rows show "by <sender> · <organisation>"', f.text.includes(`by ${adB.u.name}`) && f.text.includes(unitB.name) && f.text.includes(unitA.name), f.text.slice(0, 300));
    await page.select('[data-recruiter-filters] select[aria-label="Organisation"]', unitB.id);
    await page.waitForFunction((a: string) => !document.body.innerText.includes(a) && document.body.innerText.includes('onlyb.'), { timeout: 30_000 }, E.onlyA);
    check('History (Super Admin): choosing an organisation narrows the list', true);
    await page.select('[data-recruiter-filters] select[aria-label="Organisation"]', '');
    await page.waitForFunction((a: string) => document.body.innerText.includes(a), { timeout: 30_000 }, E.onlyA);
    await page.screenshot({ path: process.env.SHOT_HISTORY ?? 'qa-orgs-history.png' });

    await openHistory(adA.token);
    check('History (Admin A): shows the Recruiter Bulk Send tab', (await buttons()).includes('Recruiter Bulk Send'));
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Recruiter Bulk Send') as HTMLElement).click());
    await page.waitForSelector('input[placeholder^="Search address, name, send name"]', { timeout: 30_000 });
    await page.type('input[placeholder^="Search address, name, send name"]', tag);
    await page.waitForFunction((a: string) => document.body.innerText.includes(a), { timeout: 60_000 }, E.onlyA);
    await sleep(500);
    const fa = await page.evaluate(() => ({ filters: !!document.querySelector('[data-recruiter-filters]'), text: document.body.innerText }));
    check('History (Admin A): no organisation/sender dropdowns, and none of B’s rows', !fa.filters && !fa.text.includes('onlyb.'), { filters: fa.filters });

    await openHistory(op.token);
    check('History (Operator): no Recruiter Bulk Send tab', !(await buttons()).includes('Recruiter Bulk Send') && (await buttons()).includes('received'), await buttons());

    const openContacts = async (token: string) => {
      await as(token);
      const probe = page.waitForResponse((r) => r.url().includes('/api/recruiters?pageSize=1'), { timeout: 120_000 });
      await page.goto(`${BASE}/contacts`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await probe;
      await page.waitForSelector('input[placeholder^="Search by name"]', { timeout: 60_000 });
      await sleep(800);
    };
    await openContacts(adA.token);
    const tabs = await page.$$eval('[role="tablist"][aria-label="Contacts or recruiters"] button', (b) => b.map((x) => x.textContent));
    check('Contacts (Admin A): Contacts and "Recruiters (Bulk Send)" tabs', JSON.stringify(tabs) === '["Contacts","Recruiters (Bulk Send)"]', tabs);
    await page.type('input[placeholder^="Search by name"]', tag);
    await page.waitForSelector('[data-recruiter-hint]', { timeout: 30_000 });
    const hint = await page.$eval('[data-recruiter-hint]', (e) => e.textContent ?? '');
    check('Contacts (Admin A): the "Also found in Recruiter Bulk Send" hint appears with A’s 4', /Also found in Recruiter Bulk Send: 4 emails/.test(hint), hint);
    const hrefs = await page.$$eval('[data-recruiter-hint] a', (a) => a.map((x) => x.getAttribute('href')));
    check('…and links to History’s Recruiter tab with the search', hrefs.some((h) => h?.startsWith('/history?tab=recruiter&q=') && h.includes(tag)), hrefs);
    await page.evaluate(() => ([...document.querySelectorAll('[data-recruiter-hint] button')].find((b) => /Show them here/.test(b.textContent ?? '')) as HTMLElement).click());
    await page.waitForSelector('[data-recruiters-tab]', { timeout: 30_000 });
    await page.waitForFunction((a: string) => document.querySelector('[data-recruiters-tab]')?.textContent?.includes(a), { timeout: 30_000 }, E.onlyA);
    const rt = await page.$eval('[data-recruiters-tab]', (e) => e.textContent ?? '');
    check('Contacts (Admin A): "Show them here" opens the Recruiters tab with the address, without B’s', rt.includes(E.onlyA) && !rt.includes(E.onlyB), rt.slice(0, 200));

    await openContacts(sa.token);
    await page.evaluate(() => ([...document.querySelectorAll('[role="tablist"][aria-label="Contacts or recruiters"] button')].find((b) => /Recruiters/.test(b.textContent ?? '')) as HTMLElement).click());
    await page.waitForSelector('[data-recruiters-tab]', { timeout: 30_000 });
    await page.type('input[placeholder^="Search by name"]', tag);
    await page.waitForFunction((a: string) => document.querySelector('[data-recruiters-tab]')?.textContent?.includes(a), { timeout: 30_000 }, E.onlyB);
    const rs = await page.$eval('[data-recruiters-tab]', (e) => e.textContent ?? '');
    check('Contacts (Super Admin): Recruiters tab lists both organisations’ addresses', rs.includes(E.onlyA) && rs.includes(E.onlyB), rs.slice(0, 200));
    await page.screenshot({ path: process.env.SHOT_CONTACTS ?? 'qa-orgs-contacts.png' });

    await openContacts(op.token);
    await page.type('input[placeholder^="Search by name"]', tag);
    await sleep(1500);
    const o = await page.evaluate(() => ({ tabs: !!document.querySelector('[role="tablist"][aria-label="Contacts or recruiters"]'), hint: !!document.querySelector('[data-recruiter-hint]') }));
    check('Contacts (Operator): no Recruiters tab and no hint', !o.tabs && !o.hint, o);
  } finally {
    await browser.close();
    const ids = [sa, adA, adB, op].map((x) => x.u.id);
    await prisma.recruiterBlastRecipient.deleteMany({ where: { blastId: { in: [blastA.id, blastB.id] } } });
    await prisma.recruiterBlast.deleteMany({ where: { id: { in: [blastA.id, blastB.id] } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workspaceMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workspace.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.orgUnit.deleteMany({ where: { id: { in: [unitA.id, unitB.id] } } });
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
