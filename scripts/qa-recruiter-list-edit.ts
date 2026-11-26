/**
 * Real check (laptop standby + running dev server, throwaway organisation): Recruiter Bulk Send → Preview list can be edited by hand —
 * select / select all matching, delete with Undo, edit a row, add one, paste several, filter / search / select / delete by domain, sort.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-recruiter-list-edit.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import puppeteer, { type Page } from 'puppeteer-core';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + String(JSON.stringify(x) ?? 'no detail').slice(0, 400)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait (up to 20 s) until the database count reaches what the page should have done. */
async function until(read: () => Promise<number>, want: number) { for (let i = 0; i < 40; i++) { if ((await read()) === want) return; await sleep(500); } }
const stamp = Date.now();
const DOMAIN = `qle-${stamp}.test`;

async function cleanup(orgId: string) {
  await prisma.recruiterBlastRecipient.deleteMany({ where: { blast: { organizationId: orgId } } });
  await prisma.recruiterBlast.deleteMany({ where: { organizationId: orgId } });
  const users = (await prisma.user.findMany({ where: { organizationId: orgId }, select: { id: true } })).map((u) => u.id);
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.workspace.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.orgUnit.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
}

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const org = await prisma.organization.create({ data: { name: `QLE ${stamp}`, allowedDomain: DOMAIN } });
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const unit = await prisma.orgUnit.create({ data: { organizationId: org.id, name: 'QA team' } });
    const admin = await prisma.user.create({ data: { organizationId: org.id, orgUnitId: unit.id, googleId: `qle-${stamp}`, email: `qle+${stamp}@${DOMAIN}`, name: 'QLE Admin', role: Role.ADMIN } });
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, orgUnitId: unit.id, ownerId: admin.id, name: `QLE ws ${stamp}` } });
    const mkBlast = (name: string, status: string) => prisma.recruiterBlast.create({ data: { organizationId: org.id, workspaceId: ws.id, createdById: admin.id, orgUnitId: unit.id, name, subject: 'Hello', html: '<p>Hi</p>', plainText: 'Hi', body: 'Hi', columns: ['Email Id', 'Name', 'Link'], emailColumn: 'Email Id', status } });
    const blast = await mkBlast('Draft list', 'DRAFT');
    const started = await mkBlast('Started list', 'COMPLETED');
    const plan: [string, number][] = [['microsoft.com', 12], ['gmail.com', 20], ['acme.in', 8], ['corp.example', 5]];
    const make = (blastId: string) => plan.flatMap(([d, n]) => Array.from({ length: n }, (_, i) => {
      const email = `${d === 'gmail.com' ? `p${i}x` : `person${i}`}@${d}`;
      return { blastId, email, name: `Person ${i} ${d}`, data: { 'Email Id': email, Name: `Person ${i} ${d}`, Link: `https://l.test/?u=${i}` } };
    }));
    await prisma.recruiterBlastRecipient.createMany({ data: make(blast.id) });
    await prisma.recruiterBlastRecipient.createMany({ data: make(started.id).slice(0, 5) });
    const TOTAL = 45;

    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: admin.id, expires: new Date(Date.now() + 3600_000) } });
    const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { cookie: `next-auth.session-token=${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
    const count = (id = blast.id) => prisma.recruiterBlastRecipient.count({ where: { blastId: id } });

    // ── API ──────────────────────────────────────────────────────────
    const base = `/api/recruiter-blasts/${blast.id}/recipients`;
    const doms = (await api('GET', `${base}?domains=1`)).body.domains;
    check('domain list: gmail.com 20 first, microsoft.com 12, acme.in 8, corp.example 5', doms[0].domain === 'gmail.com' && doms[0].count === 20 && doms.length === 4, doms);
    check('domain search "micro" finds one', (await api('GET', `${base}?domains=1&dq=micro`)).body.domains.length === 1);
    const byDom = (await api('GET', `${base}?domain=acme.in,corp.example`)).body;
    check('filter by two domains: 13 recruiters', byDom.total === 13, byDom.total);
    check('filter + search together', (await api('GET', `${base}?domain=microsoft.com&q=person3`)).body.total >= 1);
    const sorted = (await api('GET', `${base}?sort=email&dir=desc`)).body.recipients;
    check('sort by email Z→A', sorted[0].email > sorted[1].email, sorted.slice(0, 2).map((r: any) => r.email));
    check('draft: canEdit and canDelete', byDom.canEdit && byDom.canDelete);
    const startedGet = (await api('GET', `/api/recruiter-blasts/${started.id}/recipients`)).body;
    check('a started send: read only', !startedGet.canEdit && !startedGet.canDelete);
    check('a started send cannot be edited by API (409)', (await api('DELETE', `/api/recruiter-blasts/${started.id}/recipients/items`, { ids: ['x'] })).status === 409 && (await count(started.id)) === 5);

    // ── Chrome ──────────────────────────────────────────────────────────
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setCookie({ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/' });
    page.on('dialog', (d) => { console.log('DIALOG', d.message().slice(0, 90)); void d.accept(); });
    await page.goto(`${BASE}/recruiter-send/${blast.id}`, { waitUntil: 'networkidle2', timeout: 180_000 });
    const clickText = (text: string) => page.evaluate((t) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim().startsWith(t)); (b as HTMLElement | undefined)?.click(); return !!b; }, text);
    await sleep(3000);
    await clickText('Open all steps');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Preview list'), { timeout: 90_000 }).catch(async () => { console.log('BODY', (await page.$eval('body', (b) => (b as HTMLElement).innerText)).slice(0, 500)); throw new Error('no Preview list button'); });
    await clickText('Preview list');
    await page.waitForSelector('[data-recruiter-table] tbody tr', { timeout: 60_000 });
    const rowsOnPage = () => page.$$eval('[data-recruiter-table] tbody tr', (t) => t.length);
    const header = () => page.$eval('#recruiter-list-title + span', (e) => (e as HTMLElement).innerText);
    check('dialog shows 45 recruiters, 50 per page', /45 recruiters/.test(await header()) && (await rowsOnPage()) === 45, await header());

    await page.click('[data-row-id] input[type=checkbox]');
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/list-open.png` });
    await page.click('[data-row-id] input[type=checkbox]');
    // domains panel: search, tick, show only
    await page.click('[data-domains-button]');
    await page.waitForSelector('[data-domains-panel] li label');
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/list-domains.png` });
    await page.type('input[aria-label="Search domains"]', 'acme');
    await page.waitForFunction(() => document.querySelectorAll('[data-domains-panel] li label').length === 1, { timeout: 15_000 }).catch(() => undefined);
    check('domain panel search narrows to acme.in', (await page.$$eval('[data-domains-panel] li label', (l) => l.length)) === 1);
    await page.click('input[aria-label="Select acme.in"]');
    await page.click('[data-domains-apply]');
    await sleep(1200);
    check('"Show only these" filters the table to 8 and shows a chip', (await rowsOnPage()) === 8 && !!(await page.$('[data-domain-chips]')), await rowsOnPage());
    await page.click('[data-domain-chips] button[aria-label^="Remove"]');
    await sleep(1200);
    check('removing the chip restores all 45', (await rowsOnPage()) === 45);

    // delete a whole domain via the panel, then undo
    await page.click('[data-domains-button]');
    await page.waitForSelector('input[aria-label="Select corp.example"]', { timeout: 15_000 });
    await page.click('input[aria-label="Select corp.example"]');
    await page.click('[data-domains-delete]');
    await sleep(1800);
    check('"Delete these" removed the 5 corp.example recruiters', (await count()) === TOTAL - 5, await count());
    check('an Undo bar appears', !!(await page.$('[data-undo-bar]')));
    await clickText('Undo');
    await until(count, TOTAL);
    check('Undo puts the 5 back (45)', (await count()) === TOTAL, await count());
    check('…with their Name and Link columns intact', !!(await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: blast.id, email: 'person0@corp.example' } }).then((r) => (r?.data as any)?.Link === 'https://l.test/?u=0')));
    await page.click('[data-domains-button]'); // close panel
    await sleep(300);

    // select rows, copy, delete
    await page.click('input[aria-label="Select person1@microsoft.com"]');
    await page.click('input[aria-label="Select person2@microsoft.com"]');
    check('selection bar says 2 selected', /2\s*selected/.test(await page.$eval('[data-selection-bar]', (e) => (e as HTMLElement).innerText)));
    await page.$eval('[data-delete-selected]', (e) => (e as HTMLElement).click()); // toasts sit on top of the corner
    await until(count, TOTAL - 2);
    if ((await count()) !== TOTAL - 2) console.log('DEBUG toasts:', await page.$$eval('[data-sonner-toast]', (t) => t.map((x) => (x as HTMLElement).innerText)), 'bar:', await page.$eval('[data-selection-bar]', (e) => (e as HTMLElement).innerText).catch(() => 'none'));
    check('the 2 ticked recruiters are deleted (43 left)', (await count()) === TOTAL - 2, await count());
    await page.waitForSelector('[data-undo-bar]');
    await clickText('Undo');
    await until(count, TOTAL);
    check('…and Undo brings them back', (await count()) === TOTAL, await count());

    // select all on page → select all matching, search "microsoft", delete all matching
    await page.type('input[aria-label="Search recruiters by email or name"]', 'microsoft');
    await sleep(1500);
    await page.click('input[aria-label="Select all on this page"]');
    check('after ticking the page, the select-all-matching link appears only when more pages exist (1 page: absent)', !(await page.evaluate(() => /Select all \d+/.test(document.querySelector('[data-selection-bar]')?.textContent ?? ''))));
    await page.click('input[aria-label="Select all on this page"]'); // untick
    await page.click('input[aria-label="Search recruiters by email or name"]');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => document.querySelectorAll('[data-recruiter-table] tbody tr').length === 45, { timeout: 20_000 }).catch(async () => {
      console.log('DEBUG rows', await rowsOnPage(), 'search', await page.$eval('input[aria-label="Search recruiters by email or name"]', (e) => (e as HTMLInputElement).value), 'header', await header());
      await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/debug.png` });
      throw new Error('rows did not come back');
    });

    // edit a row
    await page.$eval('[data-row-id] button[data-edit]', (e) => (e as HTMLElement).click());
    await page.waitForSelector('input[aria-label^="Edit Name"]');
    await page.$eval('input[aria-label^="Edit Name"]', (e) => { (e as HTMLInputElement).select(); });
    await page.keyboard.type('Renamed Person');
    await page.keyboard.press('Enter');
    await sleep(1500);
    check('edit saved: the first row has the new name', !!(await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: blast.id, name: 'Renamed Person' } })));
    // Escape while editing cancels the edit, does not close the dialog
    await page.$eval('[data-row-id] button[data-edit]', (e) => (e as HTMLElement).click());
    await page.waitForSelector('input[aria-label^="Edit Name"]');
    await page.keyboard.press('Escape');
    await sleep(300);
    check('Escape cancels the edit and keeps the list open', !(await page.$('input[aria-label^="Edit Name"]')) && !!(await page.$('[data-recruiter-table]')));

    // add one
    await clickText('Add recruiter');
    await page.waitForSelector('[data-add-one]');
    await page.type('input[aria-label="New Email Id"]', 'newbie@fresh.org');
    await page.type('input[aria-label="New Name"]', 'Newbie');
    await page.keyboard.press('Enter');
    await sleep(1500);
    check('added: newbie@fresh.org is in the list with its name', (await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: blast.id, email: 'newbie@fresh.org' } }))?.name === 'Newbie');
    // adding a duplicate
    await page.type('input[aria-label="New Email Id"]', 'NEWBIE@fresh.org');
    await page.keyboard.press('Enter');
    await sleep(1200);
    check('a duplicate is refused (still one newbie)', (await prisma.recruiterBlastRecipient.count({ where: { blastId: blast.id, email: { contains: 'newbie@', mode: 'insensitive' } } })) === 1);
    await clickText('Cancel');

    // paste several
    await clickText('Paste emails');
    await page.waitForSelector('[data-add-paste] textarea');
    await page.type('[data-add-paste] textarea', 'one@paste.io\nAsha Rao <two@paste.io>\nnot-an-email\nperson0@microsoft.com');
    await clickText('Add 4');
    await until(count, TOTAL + 3);
    check('pasted: two new ones added, the invalid and the existing skipped', (await prisma.recruiterBlastRecipient.count({ where: { blastId: blast.id, email: { endsWith: '@paste.io' } } })) === 2 && (await count()) === TOTAL + 3, await count());

    // sort by email in the UI
    await page.click('th button[data-sort="email"]');
    await page.waitForFunction(() => document.querySelector('[data-recruiter-table] tbody tr:first-child td:nth-child(3)')?.textContent === 'newbie@fresh.org', { timeout: 15_000 }).catch(() => undefined);
    const first = await page.$eval('[data-recruiter-table] tbody tr:first-child td:nth-child(3)', (e) => e.textContent);
    check('clicking the Email header sorts A→Z', first === 'newbie@fresh.org', first);
    

    // delete all matching a search (page 2 exists: 48 rows → still 1 page of 50; use domain gmail via search)
    await page.type('input[aria-label="Search recruiters by email or name"]', 'gmail.com');
    await page.waitForFunction(() => document.querySelectorAll('[data-recruiter-table] tbody tr').length === 20, { timeout: 20_000 });
    await page.click('input[aria-label="Select all on this page"]');
    await page.$eval('[data-delete-selected]', (e) => (e as HTMLElement).click()); // toasts sit on top of the corner
    await until(count, TOTAL + 3 - 20);
    check('all 20 gmail.com recruiters are deleted', (await prisma.recruiterBlastRecipient.count({ where: { blastId: blast.id, email: { endsWith: '@gmail.com' } } })) === 0, await count());

    // started send: read-only dialog
    await page.goto(`${BASE}/recruiter-send/${started.id}`, { waitUntil: 'networkidle2', timeout: 180_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Preview list'), { timeout: 60_000 });
    await clickText('Preview list');
    await page.waitForSelector('[data-recruiter-table] tbody tr', { timeout: 60_000 });
    check('a started send: no checkboxes, no edit or add buttons', !(await page.$('[data-row-id] button[data-edit]')) && !(await page.$('[data-add-menu]')) && !(await page.$('input[aria-label="Select all on this page"]')));
    await pageErrors(page);
  } finally {
    await browser.close();
    await cleanup(org.id).catch((e) => console.error('cleanup', e));
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
async function pageErrors(_p: Page) { /* reserved */ }
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
