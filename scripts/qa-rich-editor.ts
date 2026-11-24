/**
 * Real check (laptop standby + running dev server): the Rich message editor in Quick Send and Recruiter Bulk Send
 * (fonts, size, colour, bold, switching between Simple / Rich / HTML), in headless Chrome with a throwaway admin.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-rich-editor.ts
 */
import crypto from 'node:crypto';
import puppeteer, { type Page } from 'puppeteer-core';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function formatSelection(page: Page, editorSel: string) {
  // Select everything typed in the editor, then use the toolbar like a person would.
  await page.click(editorSel);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  const pickOption = async (label: string, value: string) => {
    await page.select(`[data-message-editor] select[aria-label="${label}"]`, value);
    await sleep(200);
  };
  await pickOption('Font', 'Georgia');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await pickOption('Size', '24');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.click('button[title="Bold"]');
  await sleep(300);
}

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const org = await prisma.organization.findFirstOrThrow({ where: { allowedDomain: 'masaischool.com' } });
  const tag = Date.now();
  const u = await prisma.user.create({ data: { organizationId: org.id, googleId: `qa-re-${tag}`, email: `qa-re-${tag}@masaischool.com`, name: 'QA Editor', role: Role.SUPER_ADMIN } });
  const w = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: u.id, name: 'QA editor ws' } });
  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
  await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: w.id, userId: u.id, emailAddress: u.email, status: 'CONNECTED', refreshTokenEnc: 'x' } });
  const draft = await prisma.recruiterBlast.create({ data: { organizationId: org.id, workspaceId: w.id, createdById: u.id, name: 'QA draft', mode: 'INDIVIDUAL', subject: 'Hello', html: '', plainText: '', body: '', columns: ['Email'], emailColumn: 'Email', status: 'DRAFT' } });
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setCookie({ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/' });
    page.on('dialog', (d) => void d.accept());

    // ---------------- Quick Send ----------------
    await page.goto(`${BASE}/quick-send`, { waitUntil: 'networkidle2', timeout: 120_000 });
    await page.waitForSelector('[data-message-editor]', { timeout: 90_000 });
    const tabs = await page.$$eval('[data-message-editor] [role="tablist"] button', (b) => b.map((x) => x.textContent));
    check('Quick Send offers Simple, Rich and HTML', JSON.stringify(tabs) === '["Simple","Rich","HTML"]', tabs);
    await page.type('#qs-body', 'Hello Sakib\n\nSee you at the drive');
    await page.evaluate(() => ([...document.querySelectorAll('[data-message-editor] [role="tablist"] button')].find((b) => b.textContent === 'Rich') as HTMLElement).click());
    await page.waitForSelector('#qs-body[contenteditable]', { timeout: 10_000 });
    const converted = await page.$eval('#qs-body', (e) => e.innerHTML);
    check('Simple → Rich keeps the text as paragraphs', /<p>Hello Sakib<\/p>\s*<p>See you at the drive<\/p>/.test(converted), converted);

    await formatSelection(page, '#qs-body[role="textbox"]');
    const rich = await page.$eval('#qs-body', (e) => e.innerHTML);
    check('the font is applied (Georgia, with a fallback)', /font-family:\s*"?Georgia"?,\s*serif/i.test(rich), rich);
    check('the size is applied (24px)', /font-size:\s*24px/.test(rich), rich);
    check('bold is applied', /<b>|font-weight:\s*bold|<strong>/.test(rich), rich);
    check('no leftover legacy size marker', !/xxx-large|size="7"/.test(rich), rich);

    await page.screenshot({ path: process.env.SHOT ?? 'qa-rich-editor.png', clip: { x: 0, y: 150, width: 1400, height: 800 } });
    const saved = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => /quick/i.test(k)).map(([, v]) => v).join('|'));
    await sleep(1200);
    const saved2 = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => /quick/i.test(k)).map(([, v]) => v).join('|'));
    check('the draft remembers the message as HTML', /"format":"html"/.test(saved2 || saved) && /Georgia/.test(saved2 || saved), (saved2 || saved).slice(0, 200));

    await page.evaluate(() => ([...document.querySelectorAll('[data-message-editor] [role="tablist"] button')].find((b) => b.textContent === 'HTML') as HTMLElement).click());
    await page.waitForSelector('textarea#qs-body', { timeout: 10_000 });
    const src = await page.$eval('#qs-body', (e) => (e as HTMLTextAreaElement).value);
    check('HTML view shows the same message as source', /Georgia/.test(src) && /Hello Sakib/.test(src), src.slice(0, 160));
    await page.evaluate(() => ([...document.querySelectorAll('[data-message-editor] [role="tablist"] button')].find((b) => b.textContent === 'Simple') as HTMLElement).click());
    await page.waitForSelector('textarea#qs-body', { timeout: 10_000 });
    const plain = await page.$eval('#qs-body', (e) => (e as HTMLTextAreaElement).value);
    check('→ Simple gives plain text back (after asking)', plain === 'Hello Sakib See you at the drive' || /Hello Sakib/.test(plain) && !/</.test(plain), plain);

    // A designed email pasted as source stays in HTML (never forced into the visual editor).
    await page.evaluate(() => ([...document.querySelectorAll('[data-message-editor] [role="tablist"] button')].find((b) => b.textContent === 'HTML') as HTMLElement).click());
    await page.$eval('#qs-body', (e) => { const t = e as HTMLTextAreaElement; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!; set.call(t, '<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>Designed</p></body></html>'); t.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(300);
    check('a designed HTML email stays in HTML view', (await page.$('textarea#qs-body')) !== null);

    // ---------------- Recruiter Bulk Send ----------------
    await page.goto(`${BASE}/recruiter-send/${draft.id}`, { waitUntil: 'networkidle2', timeout: 120_000 });
    await page.waitForSelector('[data-message-editor]', { timeout: 90_000 });
    check('Recruiter Bulk Send has the same editor', (await page.$$('[data-message-editor] [role="tablist"] button')).length === 3);
    await page.evaluate(() => ([...document.querySelectorAll('[data-message-editor] [role="tablist"] button')].find((b) => b.textContent === 'Rich') as HTMLElement).click());
    await page.waitForSelector('[contenteditable][role="textbox"]', { timeout: 10_000 });
    await page.click('[contenteditable][role="textbox"]');
    await page.keyboard.type('Dear Hiring Team');
    await formatSelection(page, '[contenteditable][role="textbox"]');
    await sleep(3500);
    const row = await prisma.recruiterBlast.findUniqueOrThrow({ where: { id: draft.id } });
    check('the draft is saved as HTML with the font', row.format === 'html' && /Georgia/.test(row.body) && /Dear Hiring Team/.test(row.body), { format: row.format, body: row.body.slice(0, 200) });
  } finally {
    await browser.close();
    await prisma.recruiterBlast.deleteMany({ where: { workspaceId: w.id } });
    await prisma.emailProviderAccount.deleteMany({ where: { userId: u.id } });
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
