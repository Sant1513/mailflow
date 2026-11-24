/**
 * Real check (laptop standby + running dev server): what an organisation's PEOPLE see as it ends: the renewal banner (dismissible
 * only when calm), the lock screen on every page but the Dashboard once expired, a full lock when disabled, Super Admins never
 * locked, and the "Request extension" action (a notification for the Super Admins, once per 12 hours).
 *   BASE_URL=http://localhost:3000 SHOTDIR=<dir> npx tsx --env-file=.env scripts/qa-orgs-lock-ui.ts
 */
import crypto from 'node:crypto';
import puppeteer, { type Page } from 'puppeteer-core';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const SHOTDIR = process.env.SHOTDIR ?? '.';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const at = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const org = await prisma.organization.findFirstOrThrow({ where: { allowedDomain: 'masaischool.com' } });
  const tag = Date.now();
  const unit = await prisma.orgUnit.create({ data: { organizationId: org.id, name: `QA lock ${tag}` } });
  const mk = async (name: string, role: Role) => {
    const u = await prisma.user.create({ data: { organizationId: org.id, orgUnitId: unit.id, googleId: `qa-lk-${name}-${tag}`, email: `qa-lk-${name}-${tag}@masaischool.com`, name: `QA ${name}`, role } });
    const w = await prisma.workspace.create({ data: { organizationId: org.id, orgUnitId: unit.id, ownerId: u.id, name: `QA ${name} ws` } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3_600_000) } });
    return { u, w, token };
  };
  const person = await mk('Person', Role.OPERATOR);
  const boss = await mk('Boss', Role.SUPER_ADMIN); // a Super Admin who happens to sit in the locked organisation
  const setOrg = (data: { status?: string; validUntil?: Date | null; graceDays?: number }) => prisma.orgUnit.update({ where: { id: unit.id }, data });

  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const open = async (who: { token: string }, path: string): Promise<Page> => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 900 });
      await page.setCookie({ name: 'next-auth.session-token', value: who.token, domain: 'localhost', path: '/' });
      await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 120_000 });
      return page;
    };
    const has = (page: Page, sel: string) => page.$(sel).then((h) => !!h);
    const banner = (page: Page) => page.$eval('[data-org-banner]', (e) => ({ level: e.getAttribute('data-org-banner'), text: e.textContent ?? '' })).catch(() => null);

    // ---------- a healthy organisation ----------
    await setOrg({ status: 'ACTIVE', validUntil: at(120), graceDays: 0 });
    let p = await open(person, '/dashboard');
    check('120 days left: no banner, no lock', !(await has(p, '[data-org-banner]')) && !(await has(p, '[data-locked-screen]')));
    await p.close();

    // ---------- 20 days left: calm banner, can be dismissed for the day ----------
    await setOrg({ validUntil: at(20) });
    p = await open(person, '/dashboard');
    const info = await banner(p);
    check('20 days left: an info banner with the days and a renewal button', info?.level === 'info' && /20 days left/.test(info.text) && /Request renewal/.test(info.text), info);
    await p.screenshot({ path: `${SHOTDIR}/org-banner-expiring.png`, clip: { x: 0, y: 0, width: 1400, height: 420 } });
    // The page may still be hydrating (dev build): click until the banner reacts.
    for (let i = 0; i < 12 && (await has(p, '[data-org-banner]')); i++) { await p.click('[data-org-banner] button[aria-label="Dismiss for today"]').catch(() => undefined); await sleep(500); }
    check('the calm banner can be dismissed', !(await has(p, '[data-org-banner]')));
    await p.reload({ waitUntil: 'networkidle2' });
    check('…and stays hidden for the rest of the day', !(await has(p, '[data-org-banner]')));
    await p.close();

    // ---------- 5 days left: urgent, cannot be dismissed ----------
    await setOrg({ validUntil: at(5) });
    p = await open(person, '/campaigns');
    const urgent = await banner(p);
    check('5 days left: an urgent banner on any page', urgent?.level === 'urgent' && /5 days left/.test(urgent.text), urgent);
    check('an urgent banner has no dismiss button', !(await has(p, '[data-org-banner] button[aria-label="Dismiss for today"]')));
    await p.close();

    // ---------- expired but inside the grace days ----------
    await setOrg({ validUntil: at(-1), graceDays: 3 });
    p = await open(person, '/campaigns');
    const grace = await banner(p);
    check('in the grace days: a red banner and the page still works', grace?.level === 'urgent' && /expired/i.test(grace.text) && !(await has(p, '[data-locked-screen]')), grace);
    await p.close();

    // ---------- expired: only the Dashboard ----------
    await setOrg({ validUntil: at(-10), graceDays: 0 });
    p = await open(person, '/dashboard');
    const dash = await banner(p);
    check('expired: the Dashboard opens, with a red banner', !(await has(p, '[data-locked-screen]')) && dash?.level === 'urgent' && /Only the Dashboard/.test(dash.text), dash);
    await p.close();
    for (const path of ['/campaigns', '/quick-send', '/inbox', '/contacts']) {
      p = await open(person, path);
      check(`expired: ${path} shows the lock screen`, await has(p, '[data-locked-screen="EXPIRED"]'));
      if (path === '/campaigns') {
        const text = await p.$eval('[data-locked-screen]', (e) => e.textContent ?? '');
        check('the lock screen says what happened, what is kept, who to contact and offers the Dashboard', /access has expired/.test(text) && /Nothing is deleted/.test(text) && /qa-lk-Boss/.test(text) && /Request extension/.test(text) && /Dashboard/.test(text), text.slice(0, 300));
        await p.screenshot({ path: `${SHOTDIR}/org-locked-screen.png`, clip: { x: 0, y: 0, width: 1400, height: 900 } });
      }
      await p.close();
    }

    // ---------- moving between pages without a reload (the layout does not redraw) ----------
    p = await open(person, '/dashboard');
    const link = await p.$('a[href="/campaigns"]');
    if (!link) throw new Error('the sidebar has no Campaigns link to click');
    await link.click();
    await p.waitForSelector('[data-locked-screen]', { timeout: 30_000 }).catch(() => undefined);
    check('walking from the Dashboard to another page locks it at once, with no reload', await has(p, '[data-locked-screen="EXPIRED"]'));
    await p.close();

    // ---------- request extension ----------
    p = await open(person, '/campaigns');
    await p.type('[data-locked-screen] textarea', 'Paid today, reference QA1');
    await p.evaluate(() => ([...document.querySelectorAll('[data-locked-screen] button')].find((b) => /Request extension/.test(b.textContent ?? '')) as HTMLElement).click());
    await p.waitForFunction(() => /Request sent/.test(document.body.innerText), { timeout: 20_000 });
    const note = await prisma.notification.findFirst({ where: { userId: boss.u.id, type: 'ORG_RENEWAL_REQUEST' }, orderBy: { createdAt: 'desc' } });
    check('the Super Admin got a notification with the message', !!note && note.title === `QA lock ${tag} asked to renew` && /Paid today, reference QA1/.test(note.body ?? ''), note);
    const second = await fetch(`${BASE}/api/org/request-extension`, { method: 'POST', headers: { cookie: `next-auth.session-token=${person.token}`, 'content-type': 'application/json' }, body: '{}' });
    check('a second request within 12 hours is 429 with a friendly message', second.status === 429 && /already sent/.test((await second.json()).error), second.status);
    const status = await (await fetch(`${BASE}/api/org/status`, { headers: { cookie: `next-auth.session-token=${person.token}` } })).json();
    check('/api/org/status still answers while locked (state, words, contacts)', status.state === 'EXPIRED' && status.message?.title && status.contacts?.some((c: { email: string }) => /qa-lk-Boss/.test(c.email)), status);
    await p.close();

    // ---------- disabled: everything, even the Dashboard ----------
    await setOrg({ status: 'DISABLED', validUntil: null });
    p = await open(person, '/dashboard');
    check('disabled: even the Dashboard is the lock screen', await has(p, '[data-locked-screen="DISABLED"]'));
    const dtext = await p.$eval('[data-locked-screen]', (e) => e.textContent ?? '');
    check('…which says the organisation is disabled and has no Dashboard link', /is disabled/.test(dtext) && !/look at the Dashboard/.test(dtext), dtext.slice(0, 200));
    await p.close();

    // ---------- a Super Admin is never locked ----------
    p = await open(boss, '/campaigns');
    check('a Super Admin in a disabled organisation is not locked and sees no banner', !(await has(p, '[data-locked-screen]')) && !(await has(p, '[data-org-banner]')));
    await p.close();
    await setOrg({ status: 'ACTIVE', validUntil: at(-30) });
    p = await open(boss, '/campaigns');
    check('…nor when it has expired', !(await has(p, '[data-locked-screen]')));
    await p.close();
  } finally {
    await browser.close();
    const ids = [person.u.id, boss.u.id];
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { targetId: unit.id }] } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workspaceMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workspace.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.orgUnit.deleteMany({ where: { id: unit.id } });
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
