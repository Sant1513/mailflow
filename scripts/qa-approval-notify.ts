/**
 * Real check (laptop standby + running dev server): System Settings → Approval notifications in Chrome, saved through the API,
 * the markers protected, and the cron route refusing callers without the secret. The standby holds a copy of real data, so the
 * summary job itself is NOT run here (it would email real approvers); its logic is covered by tests/campaigns/approvalNotify.test.ts.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-approval-notify.ts
 */
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const org = await prisma.organization.findFirstOrThrow({ where: { allowedDomain: 'masaischool.com' } });
  const unit = await prisma.orgUnit.findFirstOrThrow({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
  const before = await prisma.integrationSettings.findUnique({ where: { organizationId: org.id } });
  const tag = Date.now();
  const mk = async (name: string, role: Role) => {
    const u = await prisma.user.create({ data: { organizationId: org.id, orgUnitId: unit.id, googleId: `qa-an-${name}-${tag}`, email: `qa-an-${name}-${tag}@masaischool.com`, name: `QA ${name}`, role } });
    const w = await prisma.workspace.create({ data: { organizationId: org.id, orgUnitId: unit.id, ownerId: u.id, name: `QA ${name} ws` } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
    return { u, w, token };
  };
  const sa = await mk('SA', Role.SUPER_ADMIN), op = await mk('Op', Role.OPERATOR);
  const api = async (method: string, path: string, token: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { cookie: `next-auth.session-token=${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    // a clean start: no stored approvals choice
    const cur = await api('GET', '/api/admin/automation-settings', sa.token);
    check('the default is one summary email (not one email per request), every 60 minutes', cur.body?.settings?.approvals?.notify === 'DIGEST' && cur.body.settings.approvals.digestMinutes === 60, cur.body?.settings?.approvals);

    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 1400 });
    await page.setCookie({ name: 'next-auth.session-token', value: sa.token, domain: 'localhost', path: '/' });
    await page.goto(`${BASE}/admin/system-settings`, { waitUntil: 'networkidle2', timeout: 120_000 });
    await page.waitForSelector('[data-approvals-settings]', { timeout: 90_000 });
    const text = await page.$eval('[data-approvals-settings]', (e) => (e as HTMLElement).innerText);
    check('the page explains the three choices', /One summary email/.test(text) && /In the app only/.test(text) && /An email for every request/.test(text), text.slice(0, 200));
    check('the summary choice is selected and shows the interval', await page.$eval('[data-approvals-settings] input[type=radio]:checked', (e) => (e.parentElement?.textContent ?? '').includes('One summary email')) && !!(await page.$('[data-approvals-settings] select[aria-label="Summary interval"]')));

    const choose = async (label: string) => { await page.evaluate((l) => { const lab = [...document.querySelectorAll('[data-approvals-settings] label')].find((x) => x.textContent?.includes(l)); (lab?.querySelector('input') as HTMLInputElement).click(); }, label); await sleep(1500); };
    await choose('In the app only');
    check('choosing "In the app only" is saved', (await api('GET', '/api/admin/automation-settings', sa.token)).body?.settings?.approvals?.notify === 'IN_APP');
    check('…and the interval box goes away (not needed)', !(await page.$('[data-approvals-settings] select[aria-label="Summary interval"]')));
    await choose('An email for every request');
    check('choosing the old way is saved', (await api('GET', '/api/admin/automation-settings', sa.token)).body?.settings?.approvals?.notify === 'EMAIL');
    await choose('One summary email');
    await page.select('[data-approvals-settings] select[aria-label="Summary interval"]', '30');
    await sleep(1500);
    const after = (await api('GET', '/api/admin/automation-settings', sa.token)).body?.settings?.approvals;
    check('the summary interval is saved (30 minutes)', after?.notify === 'DIGEST' && after.digestMinutes === 30, after);
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/approval-settings.png`, clip: { x: 0, y: 0, width: 1300, height: 1400 } });

    const forged = await api('PUT', '/api/admin/automation-settings', sa.token, { approvals: { lastDigestAt: '2099-01-01T00:00:00Z', lastDigestIds: ['x'] } });
    const markers = (await api('GET', '/api/admin/automation-settings', sa.token)).body?.settings?.approvals;
    check('the summary markers cannot be written from the form', forged.status === 200 && markers.lastDigestAt === null && markers.lastDigestIds.length === 0, markers);
    check('a silly interval is refused', (await api('PUT', '/api/admin/automation-settings', sa.token, { approvals: { digestMinutes: 5 } })).status === 400);
    check('an operator cannot change it (403)', (await api('PUT', '/api/admin/automation-settings', op.token, { approvals: { notify: 'EMAIL' } })).status === 403);
    const cron = await fetch(BASE + '/api/cron/approval-digest');
    check('the summary job refuses callers without the secret (401)', cron.status === 401, cron.status);
  } finally {
    await browser.close();
    if (before) await prisma.integrationSettings.update({ where: { organizationId: org.id }, data: { settings: before.settings as object } });
    else await prisma.integrationSettings.deleteMany({ where: { organizationId: org.id } });
    for (const x of [sa, op]) {
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
