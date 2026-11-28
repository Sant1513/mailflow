/**
 * Real check (laptop standby + running dev server, throwaway organisation): the Gmail-style inbox — bounce-only threads hidden,
 * compact rows with hover actions, and the thread view (latest message open, older ones one line, "older messages" pill,
 * details, Reply / r / e shortcuts).
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-inbox-gmail.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + String(JSON.stringify(x) ?? '').slice(0, 400)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();
const DOMAIN = `qig-${stamp}.test`;

async function cleanup(orgId: string) {
  const wss = (await prisma.workspace.findMany({ where: { organizationId: orgId }, select: { id: true } })).map((w) => w.id);
  const convs = (await prisma.conversation.findMany({ where: { workspaceId: { in: wss } }, select: { id: true } })).map((c) => c.id);
  await prisma.internalNote.deleteMany({ where: { conversationId: { in: convs } } });
  await prisma.conversationMessage.deleteMany({ where: { conversationId: { in: convs } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convs } } });
  await prisma.contact.deleteMany({ where: { workspaceId: { in: wss } } });
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
  const org = await prisma.organization.create({ data: { name: `QIG ${stamp}`, allowedDomain: DOMAIN } });
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const unit = await prisma.orgUnit.create({ data: { organizationId: org.id, name: 'QA team' } });
    const user = await prisma.user.create({ data: { organizationId: org.id, orgUnitId: unit.id, googleId: `qig-${stamp}`, email: `qig+${stamp}@${DOMAIN}`, name: 'QIG Admin', role: Role.ADMIN } });
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, orgUnitId: unit.id, ownerId: user.id, name: 'QIG ws' } });
    const acct = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: user.id, emailAddress: `box+${stamp}@${DOMAIN}`, displayName: 'box', status: 'CONNECTED' } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3600_000) } });

    const mkConv = async (tag: string, name: string) => {
      const email = `${tag}+${stamp}@gmail.com`;
      const c = await prisma.contact.create({ data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: email, name } });
      const conv = await prisma.conversation.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: user.id, contactId: c.id, recipientEmail: email, subject: `Subject ${tag}`, emailProviderAccountId: acct.id, gmailThreadId: `QIG-${tag}-${stamp}`, messageCount: 0, firstMessageAt: new Date(), lastMessageAt: new Date(), unread: true } });
      return { conv, email };
    };
    const addMsg = (convId: string, email: string, i: number, dir: 'INBOUND' | 'OUTBOUND', over: Record<string, unknown> = {}) => prisma.conversationMessage.create({ data: { conversationId: convId, gmailThreadId: `QIG-${convId}`, direction: dir, classification: 'HUMAN_REPLY', senderEmail: dir === 'INBOUND' ? email : acct.emailAddress, senderName: dir === 'INBOUND' ? 'Priya Recruiter' : 'Box', recipientEmail: dir === 'INBOUND' ? acct.emailAddress : email, cc: [], bcc: [], subject: 'Subject', snippet: `Message number ${i} text`, htmlBody: `<p>Body of message ${i}</p>`, plainTextBody: `Body of message ${i}`, sentAt: new Date(Date.now() - (10 - i) * 3600_000), receivedAt: new Date(Date.now() - (10 - i) * 3600_000), status: dir === 'INBOUND' ? 'RECEIVED' : 'SENT', isRead: dir === 'OUTBOUND' || i < 7, ...over } });

    const long = await mkConv('long', 'Priya Recruiter');
    for (let i = 1; i <= 7; i++) await addMsg(long.conv.id, long.email, i, i % 2 ? 'INBOUND' : 'OUTBOUND');
    await prisma.conversation.update({ where: { id: long.conv.id }, data: { messageCount: 7 } });
    const short = await mkConv('short', 'Short Thread');
    await addMsg(short.conv.id, short.email, 1, 'INBOUND');
    await prisma.conversation.update({ where: { id: short.conv.id }, data: { messageCount: 1 } });
    const bounce = await mkConv('bounce', 'Bounce Only');
    await addMsg(bounce.conv.id, 'mailer-daemon@googlemail.com', 1, 'INBOUND', { classification: 'DELIVERY_FAILURE', senderName: 'Mail Delivery Subsystem', subject: 'Delivery Status Notification (Failure)' });
    await prisma.conversation.update({ where: { id: bounce.conv.id }, data: { messageCount: 1 } });
    const sent = await mkConv('sentbounce', 'Sent Then Bounced');
    await addMsg(sent.conv.id, sent.email, 1, 'OUTBOUND');
    await addMsg(sent.conv.id, 'mailer-daemon@googlemail.com', 2, 'INBOUND', { classification: 'BOUNCE' });
    await prisma.conversation.update({ where: { id: sent.conv.id }, data: { messageCount: 2 } });

    const api = async (path: string) => { const r = await fetch(BASE + path, { headers: { cookie: `next-auth.session-token=${token}` } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
    const list = (await api('/api/inbox?filter=all')).body;
    const subjects = list.conversations.map((c: any) => c.subject);
    check('a conversation holding only a bounce is hidden from the inbox', !subjects.includes('Subject bounce'), subjects);
    check('…but a conversation we wrote in, that later got a bounce, stays', subjects.includes('Subject sentbounce') && subjects.includes('Subject long') && subjects.includes('Subject short'), subjects);
    check('the filter counts leave the bounce out too (3 open, 3 total)', list.total === 3 && list.counts.open === 3, [list.total, list.counts]);

    // ── Chrome ──────────────────────────────────────────────────────────
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setCookie({ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/' });
    await page.goto(`${BASE}/inbox?filter=all`, { waitUntil: 'networkidle2', timeout: 180_000 });
    await page.waitForSelector('[data-conversation]', { timeout: 90_000 });
    const rowText = await page.$eval(`[data-conversation="${long.conv.id}"]`, (e) => (e as HTMLElement).innerText);
    check('list row: sender with count "(7)", subject and the start of the last message on one line', /Priya Recruiter\s*\(7\)/.test(rowText) && /Subject long/.test(rowText) && /Message number 7/.test(rowText), rowText);
    check('the bounce-only thread is not in the list', !(await page.$(`[data-conversation="${bounce.conv.id}"]`)));
    await page.hover(`[data-conversation="${short.conv.id}"]`);
    check('hovering a row shows resolve / mark-read buttons', !!(await page.$(`[data-conversation="${short.conv.id}"] [data-quick-resolve]`)) && await page.$eval(`[data-conversation="${short.conv.id}"] [data-quick-resolve]`, (e) => (e as HTMLElement).offsetParent !== null));
    await page.$eval(`[data-conversation="${short.conv.id}"] [data-quick-resolve]`, (e) => (e as HTMLElement).click());
    for (let i = 0; i < 20 && (await prisma.conversation.findUnique({ where: { id: short.conv.id } }))?.status !== 'RESOLVED'; i++) await sleep(500);
    check('quick resolve works from the row', (await prisma.conversation.findUnique({ where: { id: short.conv.id } }))?.status === 'RESOLVED');
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/inbox-list.png` });

    await page.goto(`${BASE}/inbox/${long.conv.id}`, { waitUntil: 'networkidle2', timeout: 180_000 });
    await page.waitForSelector('[data-thread] [data-message]', { timeout: 90_000 });
    await sleep(1000);
    const state = () => page.$$eval('[data-thread] [data-message]', (els) => els.map((e) => e.getAttribute('data-state')));
    const st = await state();
    check('long thread: first message, an "older messages" pill, then the last three — 4 shown', st.length === 4 && !!(await page.$('[data-older]')), st);
    check('only the newest message is open; the rest are one-line rows', st[st.length - 1] === 'expanded' && st.slice(0, -1).every((x) => x === 'collapsed'), st);
    await page.click('[data-older]');
    await sleep(500);
    check('"older messages" reveals all 7', (await state()).length === 7);
    await page.click('[data-message][data-state="collapsed"]');
    await sleep(500);
    check('clicking a collapsed row opens it', (await state()).filter((x) => x === 'expanded').length === 2);
    await page.click('[data-expand-all]');
    await sleep(500);
    check('Expand all opens every message', (await state()).every((x) => x === 'expanded'));
    await page.click('[data-expand-all]');
    await sleep(500);
    check('Collapse all leaves only the newest open', (await state()).filter((x) => x === 'expanded').length === 1);
    await page.click('[data-message][data-state="expanded"] button[aria-expanded]');
    check('the "to me" arrow shows from / to / date details', !!(await page.waitForSelector('[data-details]', { timeout: 5000 }).catch(() => null)));
    check('the subject is a large heading with the sender line below', (await page.$eval('[data-thread-subject]', (e) => e.textContent)) === 'Subject long');

    check('the reply box is closed until you ask for it', !!(await page.$('[data-open-reply]')) && await page.$eval('[data-composer]', (e) => (e as HTMLElement).offsetParent === null));
    await page.keyboard.press('r');
    await sleep(800);
    check('pressing r opens the reply box', await page.$eval('[data-composer]', (e) => (e as HTMLElement).offsetParent !== null));
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/thread-gmail.png` });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('e');
    await sleep(2500);
    check('pressing e resolves the conversation', (await prisma.conversation.findUnique({ where: { id: long.conv.id } }))?.status === 'RESOLVED');
  } finally {
    await browser.close();
    await cleanup(org.id).catch((e) => console.error('cleanup', e));
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
