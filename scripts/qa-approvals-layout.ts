/**
 * Real check (laptop standby + running dev server): the Approvals table keeps a readable Campaign column at every width.
 * The API answer is replaced with long, realistic rows (the screenshot that showed the name broken one word per line).
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-approvals-layout.ts
 */
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)}`); };

const row = (i: number) => ({
  id: `c${i}`, name: `Exploring a Talent & Learning Partnership with DealShare · 25 Nov 2026, 1:12 pm`, status: 'PENDING_APPROVAL', sendsOnApproval: true,
  workspace: { id: 'w1', name: "Mannan Dasankop's Workspace" }, requester: { id: 'u1', name: 'Mannan Dasankop', email: 'mannan.dasankop@masaischool.com' },
  dataset: 'Quick send · Exploring a Talent & Learning Partnership with DealShare · 25 Nov 2026, 1:12 pm', recipients: 7,
  template: 'Quick send · Exploring a Talent & Learning Partnership with DealShare · 25 Nov 2026, 1:12 pm v1',
  subjectLine: 'Exploring a Talent & Learning Partnership with DealShare', submittedAt: new Date(Date.now() - 60_000).toISOString(), decidedAt: null, reviewer: null, reason: null, remarks: null,
  requestEmail: null, decisionEmail: null, canDecide: true, isOwn: false,
});

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const org = await prisma.organization.findFirstOrThrow({ where: { allowedDomain: 'masaischool.com' } });
  const unit = await prisma.orgUnit.findFirstOrThrow({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
  const tag = Date.now();
  const u = await prisma.user.create({ data: { organizationId: org.id, orgUnitId: unit.id, googleId: `qa-al-${tag}`, email: `qa-al-${tag}@masaischool.com`, name: 'QA Layout', role: Role.SUPER_ADMIN } });
  const w = await prisma.workspace.create({ data: { organizationId: org.id, orgUnitId: unit.id, ownerId: u.id, name: 'QA layout ws' } });
  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setCookie({ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/' });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (/\/api\/approvals\?/.test(req.url())) {
        void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ requests: [1, 2, 3, 4].map(row), total: 4, counts: { PENDING_APPROVAL: 4, APPROVED: 0, REJECTED: 0 }, scope: 'organization', page: 1, pageSize: 50, pages: 1 }) });
      } else void req.continue();
    });
    for (const width of [1500, 1200, 1000, 800, 500]) {
      await page.setViewport({ width, height: 900 });
      await page.goto(`${BASE}/approvals`, { waitUntil: 'networkidle2', timeout: 120_000 });
      await page.waitForSelector('table tbody tr', { timeout: 60_000 });
      const m = await page.evaluate(() => {
        const cell = document.querySelector('table tbody tr td') as HTMLElement;
        const link = cell.querySelector('a') as HTMLElement;
        const lines = Math.round(link.getBoundingClientRect().height / parseFloat(getComputedStyle(link).lineHeight || '20'));
        const btn = [...document.querySelectorAll('button')].find((b) => /Approve/.test(b.textContent ?? '') && (b as HTMLElement).offsetParent !== null) as HTMLElement;
        const btnLines = Math.round(btn.getBoundingClientRect().height / 20);
        const reach = btn.getBoundingClientRect().right <= window.innerWidth;
        return { reach, cellWidth: Math.round(cell.getBoundingClientRect().width), nameLines: lines, buttonHeight: Math.round(btn.getBoundingClientRect().height), pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 2, btnLines };
      });
      check(`${width}px: the campaign column is at least 260px wide (was ~150px)`, m.cellWidth >= 255, m);
      check(`${width}px: the campaign name takes at most 3 lines (was 10+)`, m.nameLines <= 3, m);
      check(`${width}px: the Approve button stays on one line`, m.buttonHeight <= 38, m);
      check(`${width}px: the Approve button is on screen without scrolling`, m.reach, m);
      check(`${width}px: the page itself does not scroll sideways (the table does, inside its panel)`, !m.pageScrollsSideways, m);
      if (width === 1000 || width === 500) await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/approvals-${width}.png` });
    }
  } finally {
    await browser.close();
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } }).catch(() => undefined);
    await prisma.workspaceMember.deleteMany({ where: { userId: u.id } });
    await prisma.workspace.deleteMany({ where: { id: w.id } });
    await prisma.user.deleteMany({ where: { id: u.id } });
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
