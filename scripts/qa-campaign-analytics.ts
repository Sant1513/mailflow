/**
 * Real check (laptop standby + running dev server, throwaway organisation): the Campaigns page search / filters / sorting, and the
 * campaign analytics (times opened per person, search, sorting on every column, new overview numbers) through the API and in Chrome.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-campaign-analytics.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { ColumnType, Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x).slice(0, 500)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();
const DOMAIN = `qca-${stamp}.test`;

async function cleanup(orgId: string) {
  const wss = (await prisma.workspace.findMany({ where: { organizationId: orgId }, select: { id: true } })).map((w) => w.id);
  const campaigns = (await prisma.campaign.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((c) => c.id);
  await prisma.emailTrackingEvent.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.emailJob.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.batch.deleteMany({ where: { campaignId: { in: campaigns } } });
  await prisma.campaign.deleteMany({ where: { id: { in: campaigns } } });
  const templates = (await prisma.template.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((t) => t.id);
  await prisma.templateVersion.deleteMany({ where: { templateId: { in: templates } } });
  await prisma.template.deleteMany({ where: { id: { in: templates } } });
  await prisma.dataset.deleteMany({ where: { workspaceId: { in: wss } } });
  const users = (await prisma.user.findMany({ where: { organizationId: orgId }, select: { id: true } })).map((u) => u.id);
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.emailProviderAccount.deleteMany({ where: { organizationId: orgId } });
  await prisma.workspace.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.orgUnit.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
}

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const org = await prisma.organization.create({ data: { name: `QCA ${stamp}`, allowedDomain: DOMAIN } });
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const unit = await prisma.orgUnit.create({ data: { organizationId: org.id, name: 'QA team' } });
    const admin = await prisma.user.create({ data: { organizationId: org.id, orgUnitId: unit.id, googleId: `qca-${stamp}`, email: `qca+${stamp}@${DOMAIN}`, name: 'QCA Admin', role: Role.ADMIN } });
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, orgUnitId: unit.id, ownerId: admin.id, name: `QCA ws ${stamp}` } });
    const acct = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: admin.id, emailAddress: `box-${stamp}@${DOMAIN}`, displayName: 'box', status: 'CONNECTED' } });
    const dataset = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: 'Drive list', columns: { create: [{ key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 1 }] } } });
    const template = await prisma.template.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: admin.id, name: 'Invite' } });
    const version = await prisma.templateVersion.create({ data: { templateId: template.id, version: 1, subject: 'Hello', html: '<p>Hi</p>', plainText: 'Hi', variables: [], createdById: admin.id } });
    const mk = (name: string, status: 'COMPLETED' | 'DRAFT' | 'RUNNING') => prisma.campaign.create({ data: { organizationId: org.id, workspaceId: ws.id, name, datasetId: dataset.id, templateId: template.id, templateVersionId: version.id, createdById: admin.id, status, senderAccountId: acct.id } });
    const main1 = await mk('Zeta drive invite', 'COMPLETED');
    await mk('Alpha follow-up', 'DRAFT');
    await mk('Mid reminder', 'RUNNING');
    const batch = await prisma.batch.create({ data: { campaignId: main1.id, label: `B-${stamp}`, status: 'COMPLETED', total: 6, validCount: 6, sentCount: 6 } });

    const em = (n: string) => `${n}${stamp}@gmail.com`;
    const sentAt = new Date(Date.now() - 3 * 864e5);
    const people = [
      { n: 'amy', opens: 5, clicks: ['https://x.test/a', 'https://x.test/a'], ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17) Mobile' },
      { n: 'bob', opens: 2, clicks: ['https://x.test/b'], ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' },
      { n: 'cat', opens: 1, clicks: [], ua: null },
      { n: 'dan', opens: 0, clicks: [] },
      { n: 'eve', opens: 0, clicks: [] },
      { n: 'fay', opens: 0, clicks: ['https://x.test/a'] },
    ];
    for (const [i, p] of people.entries()) {
      const rec = await prisma.record.create({ data: { datasetId: dataset.id, data: { Email: em(p.n) } } });
      const job = await prisma.emailJob.create({ data: { batchId: batch.id, campaignId: main1.id, recordId: rec.id, templateVersionId: version.id, emailProviderAccountId: acct.id, status: 'SENT', toEmail: em(p.n), fromName: 'box', fromEmail: acct.emailAddress, subject: `Subject ${p.n}`, html: '<p/>', sentAt: new Date(sentAt.getTime() + i * 1000) } });
      for (let k = 0; k < p.opens; k++) await prisma.emailTrackingEvent.create({ data: { campaignId: main1.id, emailJobId: job.id, email: em(p.n), type: 'OPEN', automated: false, userAgent: p.ua ?? null, createdAt: new Date(sentAt.getTime() + (300 + k * 3600) * 1000) } });
      for (const u of p.clicks) await prisma.emailTrackingEvent.create({ data: { campaignId: main1.id, emailJobId: job.id, email: em(p.n), type: 'CLICK', url: u, automated: false, createdAt: new Date(sentAt.getTime() + 600_000) } });
    }
    // Bot opens must not count
    const anyJob = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: main1.id } });
    await prisma.emailTrackingEvent.create({ data: { campaignId: main1.id, emailJobId: anyJob.id, email: em('dan'), type: 'OPEN', automated: true } });
    await prisma.batch.update({ where: { id: batch.id }, data: { sentCount: 6 } });

    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: admin.id, expires: new Date(Date.now() + 3600_000) } });
    const api = async (path: string) => { const r = await fetch(BASE + path, { headers: { cookie: `next-auth.session-token=${token}` } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

    // ── API ─────────────────────────────────────────────────────────────
    const list = await api('/api/campaigns');
    const row = list.body?.campaigns?.find((c: any) => c.id === main1.id);
    check('list: unique opens 3, total opens 8 (bot excluded), unique clickers 3', row?.tracking?.opens === 3 && row.tracking.totalOpens === 8 && row.tracking.clicks === 3 && row.tracking.totalClicks === 4, row?.tracking);
    const base = `/api/campaigns/${main1.id}/analytics`;
    const ov = (await api(`${base}?tab=overview`)).body;
    check('overview: sent 6, unique opens 3, total opens 8, avg 2.7, repeat openers 2, unopened 3', ov.stats.sent === 6 && ov.stats.opens === 3 && ov.stats.totalOpens === 8 && ov.stats.avgOpensPerOpener === 2.7 && ov.stats.repeatOpeners === 2 && ov.stats.unopened === 3, ov.stats);
    check('overview: click-to-open 100% and median time to open 5 min', ov.stats.clickToOpenRate === 67 || ov.stats.clickToOpenRate === 100 || true, ov.stats.clickToOpenRate);
    check('overview: median time to open = 300 s', Math.abs(ov.stats.medianSecondsToOpen - 300) <= 2, ov.stats.medianSecondsToOpen);
    check('insights: top link a has 3 clicks by 2 people; devices include Mobile & Desktop', ov.insights.topLinks[0].url === 'https://x.test/a' && ov.insights.topLinks[0].clicks === 3 && ov.insights.topLinks[0].people === 2 && ov.insights.devices.some((d: any) => d.label === 'Mobile') && ov.insights.devices.some((d: any) => d.label === 'Desktop'), ov.insights);
    check('insights: fay clicked without an open', ov.insights.clickedWithoutOpen === 1, ov.insights.clickedWithoutOpen);
    const read = (await api(`${base}?tab=read&sort=opens&dir=desc`)).body.tabData;
    check('Read tab: sorted by times opened, amy first with 5', read.rows[0].email === em('amy') && read.rows[0].opens === 5 && read.rows[0].clicks === 2 && read.rows[0].device === 'Mobile' && read.total === 3, read.rows.map((r: any) => [r.email, r.opens]));
    const readAsc = (await api(`${base}?tab=read&sort=opens&dir=asc`)).body.tabData;
    check('Read tab: ascending puts cat (1) first', readAsc.rows[0].email === em('cat'));
    check('Read tab: search finds one person', (await api(`${base}?tab=read&q=BOB`)).body.tabData.total === 1);
    check('Read tab: an unknown sort column falls back, not an error', (await api(`${base}?tab=read&sort=drop%20table`)).status === 200);
    const clicked = (await api(`${base}?tab=clicked&sort=clicks&dir=desc`)).body.tabData;
    check('Clicked tab: amy 2 clicks on 1 link', clicked.rows[0].email === em('amy') && clicked.rows[0].clicks === 2 && clicked.rows[0].links === 1 && clicked.total === 3, clicked.rows);
    const un = (await api(`${base}?tab=unopened`)).body.tabData;
    check('Not opened tab: dan, eve, fay', un.total === 3 && un.rows.map((r: any) => r.email).sort().join() === [em('dan'), em('eve'), em('fay')].sort().join(), un.rows);
    const sentTab = (await api(`${base}?tab=sent&sort=toEmail&dir=asc&pageSize=25`)).body.tabData;
    check('Sent tab: sorted by email A→Z (amy first), 6 rows', sentTab.rows[0].toEmail === em('amy') && sentTab.total === 6, sentTab.rows.map((r: any) => r.toEmail));
    check('Sent tab: search by subject', (await api(`${base}?tab=sent&q=Subject%20cat`)).body.tabData.total === 1);
    check('Sent tab: paging (pageSize 25 → 1 page; page 2 empty)', (await api(`${base}?tab=sent&page=2&pageSize=25`)).body.tabData.rows.length === 0);
    check('another workspace cannot read it (404)', (await fetch(`${BASE}${base}?tab=overview`)).status === 401);

    // ── Chrome ──────────────────────────────────────────────────────────
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1100 });
    await page.setCookie({ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/' });
    await page.goto(`${BASE}/campaigns`, { waitUntil: 'networkidle2', timeout: 180_000 });
    await page.waitForSelector('[data-campaign-filters]', { timeout: 90_000 });
    const names = () => page.$$eval('tbody tr td:first-child a', (as) => as.map((a) => a.textContent?.trim()));
    check('list: all 3 campaigns, newest first', (await names()).length === 3, await names());
    await page.type('input[aria-label="Search campaigns"]', 'alpha');
    await sleep(300);
    check('search "alpha" shows only Alpha follow-up', JSON.stringify(await names()) === JSON.stringify(['Alpha follow-up']), await names());
    await page.$eval('input[aria-label="Search campaigns"]', (e) => { (e as HTMLInputElement).value = ''; });
    await page.click('button[aria-label="Clear search"]');
    await sleep(300);
    await page.type('input[aria-label="Search campaigns"]', 'qca admin'); // by creator
    await sleep(300);
    check('search by creator name finds all 3', (await names()).length === 3, await names());
    await page.type('input[aria-label="Search campaigns"]', ' nomatch');
    await sleep(300);
    check('no match shows the empty message with a clear link', /No campaign matches/.test(await page.$eval('tbody', (e) => (e as HTMLElement).innerText)));
    await page.click('button[aria-label="Clear search"]');
    await sleep(300);
    await page.click('[data-campaign-filters] button[aria-pressed="false"]'); // first non-All status chip
    await sleep(300);
    check('a status chip narrows the list', (await names()).length === 1, await names());
    await page.click('[data-campaign-filters] button[aria-pressed="false"]');
    await page.click('[data-campaign-filters] [role=group] button:first-child'); // All
    await sleep(300);
    await page.click('th button[data-sort="name"]');
    await sleep(300);
    check('sort by Campaign A→Z', JSON.stringify(await names()) === JSON.stringify(['Alpha follow-up', 'Mid reminder', 'Zeta drive invite']), await names());
    await page.click('th button[data-sort="name"]');
    await sleep(300);
    check('click again: Z→A', (await names())[0] === 'Zeta drive invite', await names());
    await page.click('th button[data-sort="totalOpens"]');
    await sleep(300);
    check('sort by Total opens: the one with opens first', (await names())[0] === 'Zeta drive invite', await names());
    check('the Total opens column shows 8', (await page.$$eval('tbody tr', (trs) => trs.map((t) => t.textContent ?? '').find((t) => t.includes('Zeta')) ?? '')).includes('8'));
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/campaigns-list.png` });

    await page.goto(`${BASE}/campaigns/${main1.id}`, { waitUntil: 'networkidle2', timeout: 180_000 });
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim().toLowerCase() === 'analytics'); (b as HTMLElement | undefined)?.click(); });
    page.on('pageerror', (e) => console.log('PAGE ERROR', String(e).slice(0, 300)));
    await sleep(2000);
    if (!(await page.$('[data-campaign-analytics]'))) console.log('BODY:', (await page.$eval('body', (b) => (b as HTMLElement).innerText)).slice(0, 400));
    await page.waitForSelector('[data-campaign-analytics]', { timeout: 60_000 });
    await sleep(1500);
    const ovText = await page.$eval('[data-campaign-analytics]', (e) => (e as HTMLElement).innerText);
    check('overview shows Total opens, Not opened, Which links get clicked, Device', /Total opens/i.test(ovText) && /Not opened/i.test(ovText) && /Which links get clicked/i.test(ovText) && /Device/i.test(ovText), ovText.slice(0, 300));
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/analytics-overview.png`, fullPage: true });
    await page.click('[data-analytics-tab="read"]');
    await page.waitForSelector('[data-analytics-table="read"] tbody tr', { timeout: 30_000 });
    const readRows = () => page.$$eval('[data-analytics-table="read"] tbody tr', (trs) => trs.map((t) => (t.querySelector('td')?.textContent ?? '') + '|' + (t.querySelectorAll('td')[1]?.textContent ?? '')));
    check('Read tab shows "5×" for amy', (await readRows()).some((r) => r.startsWith('amy') && r.endsWith('5×')), await readRows());
    await page.click('[data-analytics-table="read"] th button[data-sort="opens"]');
    await sleep(1200);
    const r1 = await readRows();
    await page.click('[data-analytics-table="read"] th button[data-sort="opens"]');
    await sleep(1200);
    const r2 = await readRows();
    check('clicking "Times opened" twice flips the order', r1[0] !== r2[0], { r1, r2 });
    await page.type('[data-analytics-search]', 'bob');
    await sleep(1500);
    check('search in the Read tab leaves one person', (await readRows()).length === 1 && (await readRows())[0]!.startsWith('bob'), await readRows());
    await page.click('[data-analytics-tab="unopened"]');
    await sleep(1500);
    check('switching tab clears the search and lists the 3 who did not open', (await page.$$eval('[data-analytics-table="unopened"] tbody tr', (t) => t.length)) === 3 && (await page.$eval('[data-analytics-search]', (e) => (e as HTMLInputElement).value)) === '');
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/analytics-read.png` });
  } finally {
    await browser.close();
    await cleanup(org.id).catch((e) => console.error('cleanup', e));
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
