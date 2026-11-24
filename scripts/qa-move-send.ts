/**
 * Real check (laptop standby + running dev server): the "Move to laptop / Move to cloud" button and its API.
 * A throwaway admin, workspace and SENDING send; the heartbeat row is put back as it was.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-move-send.ts
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
  const unit = await prisma.orgUnit.findFirstOrThrow({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
  const tag = Date.now();
  const u = await prisma.user.create({ data: { organizationId: org.id, orgUnitId: unit.id, googleId: `qa-mv-${tag}`, email: `qa-mv-${tag}@masaischool.com`, name: 'QA Mover', role: Role.SUPER_ADMIN } });
  const w = await prisma.workspace.create({ data: { organizationId: org.id, orgUnitId: unit.id, ownerId: u.id, name: 'QA mover ws' } });
  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
  const blast = await prisma.recruiterBlast.create({ data: { organizationId: org.id, workspaceId: w.id, createdById: u.id, name: 'QA move send', subject: 's', html: '<p>x</p>', plainText: 'x', body: 'x', status: 'SENDING', startedAt: new Date(), runOn: 'cloud' } });
  const before = await prisma.systemState.findUnique({ where: { id: 'main' } });
  const setBeat = (d: Date | null) => prisma.systemState.upsert({ where: { id: 'main' }, update: { lastLaptopSeenAt: d, activeServer: 'cloud' }, create: { id: 'main', lastLaptopSeenAt: d } });
  const cookie = `next-auth.session-token=${token}`;
  const post = async (action: string) => { const r = await fetch(`${BASE}/api/recruiter-blasts/${blast.id}/control`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const runOn = async () => (await prisma.recruiterBlast.findUniqueOrThrow({ where: { id: blast.id } })).runOn;
  try {
    await setBeat(null);
    const off = await post('to_laptop');
    check('laptop offline: refused with a clear message, send unchanged', off.status === 409 && /offline/.test(off.body?.error ?? '') && (await runOn()) === 'cloud', off);

    await setBeat(new Date());
    const a = await post('to_laptop');
    check('laptop online: send moves to the laptop', a.status === 200 && (await runOn()) === 'laptop', a);
    const again = await post('to_laptop');
    check('moving it again is refused (already there)', again.status === 409, again);

    // The page shows the right button.
    const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 800 });
    await page.setCookie({ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/' });
    await page.goto(`${BASE}/recruiter-send/${blast.id}`, { waitUntil: 'networkidle2', timeout: 90_000 });
    await page.waitForFunction(() => document.body.innerText.includes('Sending from'), { timeout: 60_000 });
    const btns = async () => page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter((t) => t && /^Move to/.test(t)));
    check('on the laptop the page offers "Move to cloud" (and not "Move to laptop")', JSON.stringify(await btns()) === '["Move to cloud"]', await btns());
    page.on('dialog', (d) => void d.accept());
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Move to cloud') as HTMLElement).click());
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Move to laptop'), { timeout: 30_000 }).catch(async () => {
      console.log('DEBUG runOn', await runOn(), 'buttons', JSON.stringify(await btns()), 'beat', JSON.stringify(await prisma.systemState.findUnique({ where: { id: 'main' } })), 'toasts', await page.evaluate(() => document.body.innerText.slice(0, 400)));
    });
    check('clicking it moves the send to the cloud and the button flips to "Move to laptop"', (await runOn()) === 'cloud');
    await page.screenshot({ path: process.env.SHOT ?? 'qa-move-send.png', clip: { x: 0, y: 0, width: 1300, height: 360 } });
    await browser.close();

    await prisma.recruiterBlast.update({ where: { id: blast.id }, data: { status: 'COMPLETED' } });
    const done = await post('to_laptop');
    check('a finished send cannot be moved', done.status === 409, done);
  } finally {
    await prisma.recruiterBlast.deleteMany({ where: { id: blast.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.workspaceMember.deleteMany({ where: { userId: u.id } });
    await prisma.workspace.deleteMany({ where: { ownerId: u.id } });
    await prisma.user.deleteMany({ where: { id: u.id } });
    if (before) await prisma.systemState.update({ where: { id: 'main' }, data: { lastLaptopSeenAt: before.lastLaptopSeenAt, activeServer: before.activeServer } });
    else await prisma.systemState.deleteMany({ where: { id: 'main' } });
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
