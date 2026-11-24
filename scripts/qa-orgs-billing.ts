/**
 * Real check (laptop standby + running dev server): the Super Admin side of the organisation lifecycle.
 * Create with seats and validity, status and days left on the page, the seat limit rule, Activate / extend (add days counted from
 * the current end date, valid until a date), the payment history, disable / enable, an expired organisation shown as such, and
 * that nobody but a Super Admin can do any of it. Throwaway users and organisations in the existing company; removed again.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-orgs-billing.ts
 */
import crypto from 'node:crypto';
import puppeteer, { type Page } from 'puppeteer-core';
import { Role, UserStatus } from '@prisma/client';
import { prisma } from '../lib/db/client';
import { newValidUntil, parseUntilDate } from '../lib/orgs/lifecycle';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)?.slice(0, 400)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T,>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T | null> => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v as T; await sleep(400); } return null; };

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const tenant = await prisma.organization.findFirstOrThrow({ where: { allowedDomain: 'masaischool.com' } });
  const tag = Date.now();
  const orgName = `QA Billing ${tag}`;
  const created = { users: [] as string[] };

  const host = await prisma.orgUnit.create({ data: { organizationId: tenant.id, name: `QA Host ${tag}`, domains: [] } });
  const mk = async (label: string, role: Role, orgUnitId: string | null, status: UserStatus = UserStatus.ACTIVE) => {
    const u = await prisma.user.create({ data: { organizationId: tenant.id, orgUnitId, googleId: `qa-bl-${label}-${tag}`, email: `qa-bl-${label}-${tag}@masaischool.com`, name: `QA ${label}`, role, status } });
    created.users.push(u.id);
    await prisma.workspace.create({ data: { organizationId: tenant.id, orgUnitId, ownerId: u.id, name: `QA ${label} ws` } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
    return { u, token };
  };
  const sa = await mk('sa', Role.SUPER_ADMIN, host.id);
  const admin = await mk('admin', Role.ADMIN, host.id);
  const operator = await mk('operator', Role.OPERATOR, host.id);
  const call = async (who: { token: string }, method: string, path: string, body?: unknown) => {
    const r = await fetch(BASE + path, { method, headers: { cookie: `next-auth.session-token=${who.token}`, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const row = () => prisma.orgUnit.findFirst({ where: { organizationId: tenant.id, name: orgName } });
  const card = (page: Page) => page.waitForSelector(`[data-org-card="${orgName}"]`, { timeout: 60_000 });
  const cardText = (page: Page) => page.$eval(`[data-org-card="${orgName}"]`, (e) => (e as HTMLElement).innerText);
  const click = (page: Page, sel: string) => page.$eval(`[data-org-card="${orgName}"] ${sel}`, (e) => (e as HTMLElement).click());

  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1500 });
    await page.setCookie({ name: 'next-auth.session-token', value: sa.token, domain: 'localhost', path: '/' });
    page.on('dialog', (d) => void d.accept());
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
    await page.goto(`${BASE}/admin/organisations`, { waitUntil: 'networkidle2', timeout: 120_000 });
    await page.waitForSelector('[data-org-create]', { timeout: 90_000 }).catch(async (e) => { console.log('PAGE TEXT', (await page.evaluate(() => document.body.innerText)).slice(0, 500)); throw e; });

    // ---- create with 2 seats, valid 30 days (through the form) ----
    await page.type('input[placeholder^="e.g. Operations"]', orgName);
    await page.type('[data-create-seats]', '2');
    await page.select('[data-create-valid-mode]', 'days');
    await page.waitForSelector('[data-create-days]');
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent === 'Add organisation') as HTMLElement).click());
    const made = await until(async () => row());
    check('the form creates the organisation with its seat limit and end date', !!made && made.seatLimit === 2 && !!made.validUntil && made.status === 'ACTIVE', made);
    const expect30 = newValidUntil({ mode: 'days', days: 30 }, null)!;
    check('the end date is 30 days from today (to the end of that India day)', !!made?.validUntil && Math.abs(made.validUntil.getTime() - expect30.getTime()) < 86_400_000, { got: made?.validUntil, expect30 });
    await card(page);
    const t1 = await cardText(page);
    check('the card shows the status, seats and days left', /Expiring in 30 days/.test(t1) && /0 \/ 2/.test(t1) && /30 days left/.test(t1), t1.slice(0, 300));

    // ---- seats: used by active people; lowering below used is refused ----
    const orgId = made!.id;
    const p1 = await mk('p1', Role.OPERATOR, orgId);
    const p2 = await mk('p2', Role.OPERATOR, orgId);
    void p1; void p2;
    await mk('pending', Role.OPERATOR, orgId, UserStatus.PENDING); // pending people do not use a seat
    const lower = await call(sa, 'PATCH', `/api/admin/org-units/${orgId}`, { seatLimit: 1 });
    check('lowering the seat limit below the active people is refused with the numbers (409)', lower.status === 409 && /2 people are active.*cannot be 1.*Disable or move 1 person/.test(lower.body?.error ?? ''), lower);
    const stillTwo = await row();
    check('…and nothing changed', stillTwo?.seatLimit === 2, stillTwo?.seatLimit);
    const ok3 = await call(sa, 'PATCH', `/api/admin/org-units/${orgId}`, { seatLimit: 3 });
    check('raising it is fine', ok3.status === 200 && (await row())?.seatLimit === 3, ok3);
    const back2 = await call(sa, 'PATCH', `/api/admin/org-units/${orgId}`, { seatLimit: 2 });
    check('lowering it to exactly the active people is fine', back2.status === 200, back2);
    await page.reload({ waitUntil: 'networkidle2' });
    await card(page);
    check('the card shows 2 / 2 and "full" (the pending person uses no seat)', /2 \/ 2/.test(await cardText(page)) && /full/.test(await cardText(page)), await cardText(page));

    // ---- Activate / extend: add 30 days from the CURRENT end date (it is still ahead) ----
    const before = (await row())!.validUntil!;
    await click(page, '[data-activate]');
    await page.waitForSelector('[data-activate-dialog]');
    await page.click('[data-quick-days="30"]');
    const preview = await page.$eval('[data-result]', (e) => (e as HTMLElement).innerText);
    const wantAfter = newValidUntil({ mode: 'days', days: 30 }, before)!;
    check('the dialog shows the resulting end date before saving', /New end date/.test(preview) && preview.includes(wantAfter.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })), { preview, wantAfter });
    await page.type('[data-activate-dialog] input[placeholder="e.g. 25000"]', '25000');
    await page.type('[data-activate-dialog] input[maxlength="120"]', 'UTR-QA-1');
    await page.click('[data-activate-save]');
    const ext = await until(async () => { const r = await row(); return r && r.validUntil && r.validUntil.getTime() !== before.getTime() ? r : null; });
    check('"add 30 days" extends from the current end date (renewing early loses nothing)', !!ext && Math.abs(ext.validUntil!.getTime() - wantAfter.getTime()) < 1000, { before, after: ext?.validUntil, wantAfter });
    const pay1 = await prisma.orgPayment.findMany({ where: { orgUnitId: orgId }, orderBy: { createdAt: 'asc' } });
    check('a payment is recorded with amount, reference, days and who', pay1.length === 1 && pay1[0]!.kind === 'EXTEND' && pay1[0]!.amountMinor === 2_500_000 && pay1[0]!.reference === 'UTR-QA-1' && pay1[0]!.days === 30 && pay1[0]!.recordedById === sa.u.id, pay1);

    // ---- valid until a date ----
    await card(page);
    await click(page, '[data-activate]');
    await page.waitForSelector('[data-activate-dialog]');
    await page.evaluate(() => ([...document.querySelectorAll('[data-activate-dialog] button')].find((b) => b.textContent === 'Valid until a date') as HTMLElement).click());
    await page.waitForSelector('[data-until-input]');
    await page.$eval('[data-until-input]', (el) => { const i = el as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(i, '2027-06-30'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(300);
    await page.click('[data-activate-save]');
    const dated = await until(async () => { const r = await row(); return r?.validUntil?.getTime() === parseUntilDate('2027-06-30')!.getTime() ? r : null; });
    check('"valid until a date" sets that date (end of the day, India time)', !!dated, (await row())?.validUntil);

    // ---- payment history ----
    await page.reload({ waitUntil: 'networkidle2' });
    await card(page);
    await click(page, '[data-history]');
    await page.waitForSelector(`[data-org-card="${orgName}"] [data-payments] table`, { timeout: 20_000 });
    const hist = await page.$eval(`[data-org-card="${orgName}"] [data-payments]`, (e) => (e as HTMLElement).innerText);
    check('the payment history lists both, newest first, with the reference and amount', /UTR-QA-1/.test(hist) && /25,000/.test(hist) && /Extended/.test(hist) && hist.indexOf('2027') < hist.indexOf('UTR-QA-1') + 200, hist);
    const apiPay = await call(sa, 'GET', `/api/admin/org-units/${orgId}/payments`);
    check('the payments API returns them (2 rows)', apiPay.status === 200 && apiPay.body?.payments?.length === 2, apiPay.body);
    await page.screenshot({ path: process.env.SHOT ?? 'qa-orgs-billing.png' });

    // ---- disable / enable ----
    await click(page, '[data-toggle-status]');
    const off = await until(async () => { const r = await row(); return r?.status === 'DISABLED' ? r : null; });
    check('Disable (after the confirmation) disables the organisation', !!off, (await row())?.status);
    await page.waitForFunction((n) => (document.querySelector(`[data-org-card="${n}"] [data-org-state]`) as HTMLElement | null)?.innerText === 'Disabled', { timeout: 15_000 }, orgName);
    check('the badge says Disabled and the button now says Enable', /Disabled/.test(await cardText(page)) && /Enable/.test(await cardText(page)));
    await click(page, '[data-toggle-status]');
    const on = await until(async () => { const r = await row(); return r?.status === 'ACTIVE' ? r : null; });
    check('Enable brings it back', !!on, (await row())?.status);
    const audits = await prisma.auditLog.findMany({ where: { targetId: orgId, action: { in: ['ORG_DISABLE', 'ORG_ENABLE', 'ORG_EXTEND', 'ORG_ACTIVATE', 'ORG_UNIT_CREATE'] } }, select: { action: true } });
    check('create, extend, disable and enable are all in the audit log', ['ORG_UNIT_CREATE', 'ORG_EXTEND', 'ORG_DISABLE', 'ORG_ENABLE'].every((a) => audits.some((x) => x.action === a)), audits.map((a) => a.action));

    // ---- an expired organisation is shown as expired, and re-activating it is an ACTIVATE ----
    await prisma.orgUnit.update({ where: { id: orgId }, data: { validUntil: new Date(Date.now() - 2 * 86_400_000) } });
    await page.reload({ waitUntil: 'networkidle2' });
    await card(page);
    check('an expired organisation shows "Expired" and how long ago', /Expired/.test(await cardText(page)) && /ended 2 days ago/.test(await cardText(page)), await cardText(page));
    const act = await call(sa, 'POST', `/api/admin/org-units/${orgId}/activate`, { mode: 'days', days: 30, note: 'renewed' });
    const payAfter = await prisma.orgPayment.findFirst({ where: { orgUnitId: orgId }, orderBy: { createdAt: 'desc' } });
    check('re-activating after expiry is an ACTIVATE, counted from today, and the organisation is open again', act.status === 200 && act.body?.kind === 'ACTIVATE' && payAfter?.kind === 'ACTIVATE' && ['EXPIRING', 'ACTIVE'].includes(act.body?.state), act);

    // ---- bad input ----
    const zero = await call(sa, 'POST', `/api/admin/org-units/${orgId}/activate`, { mode: 'days', days: 0 });
    const past = await call(sa, 'POST', `/api/admin/org-units/${orgId}/activate`, { mode: 'until', until: '2020-01-01' });
    const junk = await call(sa, 'POST', `/api/admin/org-units/${orgId}/activate`, { mode: 'forever' });
    check('days of 0, a past date and a junk mode are refused (400) with a message', zero.status === 400 && past.status === 400 && junk.status === 400 && !!zero.body?.error && !!past.body?.error, [zero, past, junk]);
    const unknown = await call(sa, 'POST', `/api/admin/org-units/does-not-exist/activate`, { mode: 'days', days: 5 });
    check('an organisation that does not exist is 404', unknown.status === 404, unknown);

    // ---- who may do it ----
    const denied = await Promise.all([admin, operator].flatMap((u) => [
      call(u, 'POST', `/api/admin/org-units/${orgId}/activate`, { mode: 'days', days: 30 }),
      call(u, 'PATCH', `/api/admin/org-units/${orgId}`, { status: 'DISABLED' }),
      call(u, 'GET', `/api/admin/org-units/${orgId}/payments`),
      call(u, 'GET', '/api/admin/org-units'),
    ]));
    check('an Admin and an Operator get 403 on every lifecycle endpoint', denied.every((d) => d.status === 403), denied.map((d) => d.status));
    check('…and nothing changed', (await row())?.status === 'ACTIVE' && (await prisma.orgPayment.count({ where: { orgUnitId: orgId } })) === 3);

    // ---- the list API carries the derived fields ----
    const list = await call(sa, 'GET', '/api/admin/org-units');
    const mine = list.body?.orgUnits?.find((o: any) => o.id === orgId);
    check('the organisations API returns state, days left, seats and validity', !!mine && ['EXPIRING', 'ACTIVE'].includes(mine.state) && mine.seatLimit === 2 && mine.seatsUsed === 2 && typeof mine.validUntil === 'string' && typeof mine.daysLeft === 'number', mine);
  } finally {
    await browser.close();
    const ids = created.users;
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.workspaceMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workspace.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.orgUnit.deleteMany({ where: { organizationId: tenant.id, name: { contains: String(tag) } } });
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
