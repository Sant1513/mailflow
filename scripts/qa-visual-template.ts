/**
 * Real check (laptop standby + running dev server): the template Visual editor in headless Chrome with a throwaway admin.
 * A designed email (doctype, meta, tables, conditional comments, CSS tab, merge fields) must survive being edited in place:
 * untouched parts stay exactly as written, editing helpers never leak into the saved HTML, and the standards bar works.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-visual-template.ts
 */
import crypto from 'node:crypto';
import puppeteer, { type Frame, type Page } from 'puppeteer-core';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DESIGNED = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drive</title>
</head>
<body style="margin:0;padding:0;background:#f0ede8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->
<table role="presentation" width="100%" style="max-width:600px;background:#ffffff;" cellpadding="0" cellspacing="0" border="0">
<tr><td class="hero" style="padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#1a1a1a;">
<p id="greet" style="margin:0 0 12px;">Dear {{Name}},</p>
<p style="margin:0;">Join the placement drive. <a href="{{ApplyLink}}">Apply here</a></p>
<img id="logo" src="https://example.com/logo.png" width="200" alt="Masai logo" style="display:block;border:0;">
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;

const frameOf = async (page: Page): Promise<Frame> => {
  const handle = await page.waitForSelector('iframe[title="Email visual editor"]', { timeout: 60_000 });
  const f = await handle!.contentFrame();
  return f!;
};

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const org = await prisma.organization.findFirstOrThrow({ where: { allowedDomain: 'masaischool.com' } });
  const tag = Date.now();
  const u = await prisma.user.create({ data: { organizationId: org.id, googleId: `qa-vt-${tag}`, email: `qa-vt-${tag}@masaischool.com`, name: 'QA Visual', role: Role.SUPER_ADMIN } });
  const w = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: u.id, name: 'QA visual ws' } });
  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
  const mkTemplate = async (name: string, html: string, css: string | null) => {
    const t = await prisma.template.create({ data: { organizationId: org.id, workspaceId: w.id, ownerId: u.id, name } });
    await prisma.templateVersion.create({ data: { templateId: t.id, version: 1, subject: 'Drive {{Name}}', html, css, variables: ['Name', 'ApplyLink'], createdById: u.id } });
    return t;
  };
  const designed = await mkTemplate('QA designed', DESIGNED, '.hero{border-left:4px solid #e5173f}');
  const empty = await mkTemplate('QA empty', '', null);
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1000 });
    await page.setCookie({ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/' });
    page.on('dialog', (d) => void d.accept());
    const latest = async (id: string) => (await prisma.templateVersion.findFirstOrThrow({ where: { templateId: id }, orderBy: { version: 'desc' } }));
    const save = async (id: string, want: number) => { await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => /Save new version/.test(b.textContent ?? '')) as HTMLElement).click()); for (let i = 0; i < 40; i++) { await sleep(500); if ((await latest(id)).version >= want) break; } };

    // ---------- a designed email ----------
    await page.goto(`${BASE}/templates/${designed.id}`, { waitUntil: 'networkidle2', timeout: 120_000 });
    const frame = await frameOf(page);
    await frame.waitForSelector('#greet', { timeout: 30_000 });
    const tabs = await page.$$eval('button', (b) => b.map((x) => x.textContent).filter((t) => t === 'Visual' || t === 'HTML' || t === 'CSS'));
    check('the template editor has Visual, HTML and CSS tabs', JSON.stringify(tabs) === '["Visual","HTML","CSS"]', tabs);
    check('the template is shown as the recipient sees it, with its CSS-tab style', await frame.evaluate(() => getComputedStyle(document.querySelector('.hero')!).borderLeftWidth === '4px'));

    // Edit a paragraph in place, then style the logo.
    await frame.click('#greet');
    await page.keyboard.press('End');
    await page.keyboard.type(' (edited)');
    await sleep(600);
    await frame.click('#logo');
    await page.waitForSelector('[data-image-panel]', { timeout: 10_000 });
    const alt = await page.$('[data-image-panel] input:nth-of-type(1)');
    void alt;
    await page.evaluate(() => { const inputs = [...document.querySelectorAll<HTMLInputElement>('[data-image-panel] input')]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(inputs[1]!, 'Masai School logo'); inputs[1]!.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(600);
    await frame.click('#greet');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.select('select[aria-label="Font"]', 'Georgia');
    await sleep(300);
    // Add a button block.
    await page.select('select[aria-label="Add a block"]', 'button');
    await sleep(800);
    await save(designed.id, 2);
    const v2 = await latest(designed.id);
    check('saving makes version 2', v2.version === 2, v2.version);
    check('the edit is in the HTML', /Dear \{\{Name\}\}[^<]*\(edited\)/.test(v2.html), v2.html.slice(0, 400));
    check('the doctype, lang, meta and title are kept', /^<!DOCTYPE html>/i.test(v2.html) && /<html lang="en">/.test(v2.html) && /name="viewport"/.test(v2.html) && /<title>Drive<\/title>/.test(v2.html));
    check('the Outlook conditional comments are kept', v2.html.includes('<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->') && v2.html.includes('<!--[if mso]></td></tr></table><![endif]-->'), v2.html.slice(300, 700));
    check('merge fields in text and in a link stay intact', v2.html.includes('href="{{ApplyLink}}"') && v2.html.includes('Apply here'));
    check('untouched markup is kept (table roles, max-width, class)', /role="presentation"/.test(v2.html) && v2.html.includes('max-width:600px') && v2.html.includes('class="hero"'));
    check('the CSS tab was not written into the HTML, and the CSS field is unchanged', !/border-left:4px/.test(v2.html) && v2.css === '.hero{border-left:4px solid #e5173f}', v2.css);
    check('no editing helpers leaked (style tags, selection class, contenteditable)', !/data-mf|mf-selected|contenteditable/.test(v2.html));
    check('the image alt text was edited', v2.html.includes('alt="Masai School logo"'));
    check('the font was applied with a fallback', /font-family:\s*"?Georgia"?,\s*serif/i.test(v2.html), v2.html.match(/font-family:[^;"]*Georgia[^;"]*/)?.[0]);
    check('the Button block is a bulletproof button (cell colour and padding)', /bgcolor="#e5173f"[^>]*padding:14px 28px/.test(v2.html));

    // The standards bar and health check.
    const bar = await page.$eval('[data-standards]', (e) => e.textContent ?? '');
    check('the standards bar reports what to fix', /to fix for email standards|Meets email standards/.test(bar), bar);
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => /Run health check/.test(b.textContent ?? '')) as HTMLElement).click());
    await page.waitForFunction(() => /email health check/i.test(document.body.innerText), { timeout: 20_000 });
    const hc = await page.evaluate(() => document.body.innerText);
    check('the health check includes the standards findings (the button still has an empty address)', /Links go somewhere/.test(hc), hc.slice(-400));
    await page.screenshot({ path: process.env.SHOT ?? 'qa-visual-template.png' });

    // ---------- an empty template ----------
    await page.goto(`${BASE}/templates/${empty.id}`, { waitUntil: 'networkidle2', timeout: 120_000 });
    await page.waitForSelector('[data-visual-empty]', { timeout: 60_000 });
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => /Use the email layout/.test(b.textContent ?? '')) as HTMLElement).click());
    const f2 = await frameOf(page);
    await f2.waitForSelector('h1', { timeout: 30_000 });
    await page.evaluate(() => { const i = document.querySelector<HTMLInputElement>('input[placeholder^="Reminder"]')!; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(i, 'Starter subject'); i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(500);
    await save(empty.id, 2);
    const s2 = await latest(empty.id);
    check('the starter layout is saved as a complete email document', s2.version === 2 && /^<!DOCTYPE html>/.test(s2.html) && /name="viewport"/.test(s2.html), s2.version);
    check('the starter only has the button address left to fill in', (await page.$eval('[data-standards]', (e) => e.textContent ?? '')).startsWith('1 to fix'), await page.$eval('[data-standards]', (e) => e.textContent));
  } finally {
    await browser.close();
    await prisma.templateVersion.deleteMany({ where: { template: { workspaceId: w.id } } });
    await prisma.template.deleteMany({ where: { workspaceId: w.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.workspaceMember.deleteMany({ where: { userId: u.id } });
    await prisma.workspace.deleteMany({ where: { ownerId: u.id } });
    await prisma.user.deleteMany({ where: { id: u.id } });
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
