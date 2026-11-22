/**
 * Real check (laptop standby + running dev server): the super-admin "Sync by user" panel and the User filter.
 * Throwaway users, workspaces, mailboxes and suppressions; removed at the end. Screenshot -> SHOT env path.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-sync-panel.ts
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
  const mk = async (name: string, role: Role) => {
    const u = await prisma.user.create({ data: { organizationId: org.id, googleId: `qa-sp-${name}-${tag}`, email: `qa-sp-${name}-${tag}@masaischool.com`, name: `QA ${name}`, role } });
    const w = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: u.id, name: `QA ${name} ws` } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
    const acc = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: w.id, userId: u.id, emailAddress: u.email, status: 'CONNECTED', refreshTokenEnc: 'not-a-real-token', bounceScanNotices: 7 } });
    return { u, w, token, acc };
  };
  const admin = await mk('Admin', Role.SUPER_ADMIN);
  const op = await mk('Operator', Role.OPERATOR);
  try {
    await prisma.emailSuppression.createMany({ data: [
      { workspaceId: op.w.id, email: `a.${tag}@corp-${tag}.com`, reason: 'BOUNCED', source: 'BOUNCE', category: 'USER_UNKNOWN', detail: 'qa' },
      { workspaceId: op.w.id, email: `b.${tag}@corp-${tag}.com`, reason: 'BOUNCED', source: 'BOUNCE', category: 'POLICY_BLOCK', detail: 'qa' },
      { workspaceId: op.w.id, email: `c.${tag}@corp-${tag}.com`, reason: 'UNSUBSCRIBED', source: 'UNSUBSCRIBE' },
      { workspaceId: admin.w.id, email: `d.${tag}@corp-${tag}.com`, reason: 'COMPLAINT', source: 'COMPLAINT', category: 'COMPLAINT', detail: 'qa' },
    ] });
    const cookie = (t: string) => `next-auth.session-token=${t}`;
    const get = async (p: string, t: string) => (await fetch(BASE + p, { headers: { cookie: cookie(t) } })).json();

    const sa = await get('/api/suppressions/scan-status', admin.token);
    check('super admin gets canSync and a line per mailbox', sa.canSync === true && Array.isArray(sa.mailboxes));
    const line = sa.mailboxes?.find((m: any) => m.email === op.u.email);
    check('the report counts that user’s workspace (3 entries: 2 bounced, 1 unsubscribed)', line?.suppressions?.total === 3 && line.suppressions.bounced === 2 && line.suppressions.unsubscribed === 1 && line.suppressions.byCategory.POLICY_BLOCK === 1, line);
    check('…with the owner’s name and notices read', line?.user === 'QA Operator' && line.notices === 7, line);

    const so = await get('/api/suppressions/scan-status', op.token);
    check('an operator gets no sync button and no per-user lines', so.canSync === false && so.mailboxes === undefined);
    const denied = await fetch(BASE + '/api/suppressions/scan-sync', { method: 'POST', headers: { cookie: cookie(op.token), 'content-type': 'application/json' }, body: JSON.stringify({ mailbox: op.u.email }) });
    check('an operator cannot run the sync (403)', denied.status === 403, denied.status);
    const none = await fetch(BASE + '/api/suppressions/scan-sync', { method: 'POST', headers: { cookie: cookie(admin.token), 'content-type': 'application/json' }, body: JSON.stringify({ mailbox: 'nobody@elsewhere.com' }) });
    check('a mailbox outside the organisation is refused (404)', none.status === 404, none.status);
    const run = await (await fetch(BASE + '/api/suppressions/scan-sync', { method: 'POST', headers: { cookie: cookie(admin.token), 'content-type': 'application/json' }, body: JSON.stringify({ mailbox: op.u.email }) })).json();
    check('syncing a mailbox that Google rejects reports a clear failure, not a crash', run.ok === false && typeof run.error === 'string' && run.more === false, run);
    const after = await get('/api/suppressions/scan-status', admin.token);
    check('…and the failure is kept on the mailbox line', !!after.mailboxes.find((m: any) => m.email === op.u.email)?.error);

    const list = await get(`/api/suppressions?workspaceId=${op.w.id}&user=${op.u.id}`, op.token);
    check('the User filter returns only that user’s entries', list.total === 3 && list.suppressions.every((s: any) => s.savedBy === 'QA Operator'), list.total);
    check('the User dropdown lists users with counts', list.users.some((u: any) => u.value === op.u.id && u.count === 3), list.users);
    const csv = await (await fetch(`${BASE}/api/suppressions?workspaceId=${op.w.id}&user=${op.u.id}&format=csv`, { headers: { cookie: cookie(op.token) } })).text();
    check('the CSV honours the user filter', csv.includes(`a.${tag}@`) && !csv.includes(`d.${tag}@`));

    // The page itself, as the super admin.
    const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1200 });
    await page.setCookie({ name: 'next-auth.session-token', value: admin.token, domain: 'localhost', path: '/' });
    await page.goto(`${BASE}/suppressions`, { waitUntil: 'networkidle2', timeout: 90_000 });
    await page.waitForSelector('[data-bounce-sync-panel]', { timeout: 60_000 });
    check('the panel shows on the page for a super admin', true);
    const hasUserFilter = await page.$('#sup-user');
    check('the User filter is on the page', !!hasUserFilter);
    // Only the throwaway mailbox is synced (the row button), never the real mailboxes on the standby.
    await page.evaluate((email) => { const row = [...document.querySelectorAll('tr')].find((r) => r.textContent?.includes(email)); ([...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Sync') as HTMLElement | undefined)?.click(); }, op.u.email);
    await page.waitForFunction(() => /Finished: \d+ of \d+/.test(document.body.innerText), { timeout: 120_000 });
    const text = await page.evaluate(() => (document.querySelector('[data-bounce-sync-panel]') as HTMLElement).innerText);
    check('"Sync all now" shows progress and finishes', /Finished: \d+ of \d+ mailboxes/.test(text), text.slice(0, 300));
    await page.evaluate((email) => { const row = [...document.querySelectorAll('tr')].find((r) => r.textContent?.includes(email)); (row?.querySelector('button[title="Advanced report"]') as HTMLElement | null)?.click(); }, op.u.email);
    await page.waitForFunction(() => document.body.innerText.includes("report"), { timeout: 10_000 });
    await page.screenshot({ path: process.env.SHOT ?? 'qa-sync-panel.png', clip: { x: 0, y: 0, width: 1400, height: 1200 } });
    await browser.close();
  } finally {
    const ids = [admin.u.id, op.u.id];
    await prisma.emailSuppression.deleteMany({ where: { workspaceId: { in: [admin.w.id, op.w.id] } } });
    await prisma.emailProviderAccount.deleteMany({ where: { userId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.workspaceMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workspace.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
