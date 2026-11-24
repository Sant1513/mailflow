/**
 * Real check (laptop standby + running dev server): an address emailed through Recruiter Bulk Send is findable in History
 * (its own tab), the Sent tab and the Contacts search point to it, and another workspace cannot see it.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-history-recruiter.ts
 */
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)}`); };

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const org = await prisma.organization.findFirstOrThrow({ where: { allowedDomain: 'masaischool.com' } });
  const tag = Date.now();
  const unitA = await prisma.orgUnit.create({ data: { organizationId: org.id, name: `QA hr A ${tag}` } });
  const unitB = await prisma.orgUnit.create({ data: { organizationId: org.id, name: `QA hr B ${tag}` } });
  const mk = async (name: string, orgUnitId: string) => {
    const u = await prisma.user.create({ data: { organizationId: org.id, googleId: `qa-hr-${name}-${tag}`, email: `qa-hr-${name}-${tag}@masaischool.com`, name: `QA ${name}`, role: Role.ADMIN, orgUnitId } });
    const w = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: u.id, orgUnitId, name: `QA ${name} ws` } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
    return { u, w, token };
  };
  const a = await mk('A', unitA.id), b = await mk('B', unitB.id);
  const target = `koustabh.qa${tag}@gmail.com`;
  const blast = await prisma.recruiterBlast.create({ data: { organizationId: org.id, workspaceId: a.w.id, orgUnitId: unitA.id, createdById: a.u.id, name: 'QA drive invite', subject: 'QA subject line', html: '<p>x</p>', plainText: 'x', body: 'x', status: 'COMPLETED', startedAt: new Date(), completedAt: new Date() } });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: blast.id, email: target, name: 'Koustabh QA', status: 'SENT', sentAt: new Date() } });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: blast.id, email: `other.${tag}@gmail.com`, status: 'BOUNCED', skipReason: 'Bounced: Address does not exist', sentAt: new Date() } });
  const get = async (path: string, token: string) => (await fetch(BASE + path, { headers: { cookie: `next-auth.session-token=${token}` } })).json();
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const r = await get(`/api/history?direction=recruiter&q=koustabh.qa${tag}`, a.token);
    check('the Recruiter Bulk Send tab finds the address', r.total === 1 && r.items[0]?.email === target && r.items[0].blast.name === 'QA drive invite' && r.items[0].status === 'SENT', r);
    const s = await get(`/api/history?direction=sent&q=koustabh.qa${tag}`, a.token);
    check('the Sent tab says it is also in Recruiter Bulk Send', s.total === 0 && s.recruiterMatches === 1, { total: s.total, m: s.recruiterMatches });
    const all = await get('/api/history?direction=recruiter&q=QA%20drive%20invite', a.token);
    check('the tab lists the send’s recruiters with their outcomes', all.counts.SENT === 1 && all.counts.BOUNCED === 1, all.counts);
    const bounced = await get('/api/history?direction=recruiter&q=QA%20drive%20invite&status=BOUNCED', a.token);
    check('the outcome filter works', bounced.total === 1 && bounced.items[0].status === 'BOUNCED', bounced.total);
    const other = await get(`/api/history?direction=recruiter&q=koustabh.qa${tag}`, b.token);
    check('an admin of another organisation does not see it', other.total === 0, other.total);

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.setCookie({ name: 'next-auth.session-token', value: a.token, domain: 'localhost', path: '/' });
    await page.goto(`${BASE}/contacts`, { waitUntil: 'networkidle2', timeout: 120_000 });
    await page.waitForSelector('input[placeholder^="Search by name"]', { timeout: 90_000 });
    await page.type('input[placeholder^="Search by name"]', `koustabh.qa${tag}`);
    await page.waitForSelector('[data-recruiter-hint]', { timeout: 15_000 });
    const hint = await page.$eval('[data-recruiter-hint]', (e) => e.textContent ?? '');
    check('Contacts search points to Recruiter Bulk Send', /Also found in Recruiter Bulk Send: 1 email/.test(hint), hint);
    await page.click('[data-recruiter-hint] a');
    await page.waitForFunction(() => document.body.innerText.includes('QA drive invite'), { timeout: 30_000 });
    check('…and the link opens History on that tab with the result', await page.evaluate(() => document.body.innerText.includes('QA subject line')));
    await page.screenshot({ path: process.env.SHOT ?? 'qa-history-recruiter.png' });
  } finally {
    await browser.close();
    await prisma.recruiterBlastRecipient.deleteMany({ where: { blastId: blast.id } });
    await prisma.recruiterBlast.deleteMany({ where: { id: blast.id } });
    await prisma.orgUnit.deleteMany({ where: { id: { in: [unitA.id, unitB.id] } } }).catch(() => undefined);
    for (const x of [a, b]) {
      await prisma.auditLog.deleteMany({ where: { actorId: x.u.id } }).catch(() => undefined);
      await prisma.session.deleteMany({ where: { userId: x.u.id } });
      await prisma.workspaceMember.deleteMany({ where: { userId: x.u.id } });
      await prisma.workspace.deleteMany({ where: { ownerId: x.u.id } });
      await prisma.user.deleteMany({ where: { id: x.u.id } });
    }
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
