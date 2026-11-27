/**
 * Real check (laptop standby + running dev server, throwaway organisation): admins see the replies that landed in colleagues'
 * mailboxes ("Team replies"), operators and other organisations do not; message bodies start at their first word.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-team-replies.ts
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
const DOMAIN = `qtr-${stamp}.test`;

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
  const org = await prisma.organization.create({ data: { name: `QTR ${stamp}`, allowedDomain: DOMAIN } });
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const teamA = await prisma.orgUnit.create({ data: { organizationId: org.id, name: 'Team A' } });
    const teamB = await prisma.orgUnit.create({ data: { organizationId: org.id, name: 'Team B' } });
    const mkUser = async (tag: string, role: Role, unit: string) => {
      const u = await prisma.user.create({ data: { organizationId: org.id, orgUnitId: unit, googleId: `qtr-${tag}-${stamp}`, email: `${tag}+${stamp}@${DOMAIN}`, name: `QTR ${tag}`, role } });
      const w = await prisma.workspace.create({ data: { organizationId: org.id, orgUnitId: unit, ownerId: u.id, name: `QTR ${tag} ws` } });
      const a = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: w.id, userId: u.id, emailAddress: `${tag}-box+${stamp}@${DOMAIN}`, displayName: tag, status: 'CONNECTED' } });
      const token = crypto.randomBytes(32).toString('hex');
      await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
      return { u, w, a, token };
    };
    const adminA = await mkUser('adminA', Role.ADMIN, teamA.id);
    const opA = await mkUser('opA', Role.OPERATOR, teamA.id);
    const opB = await mkUser('opB', Role.OPERATOR, teamB.id);
    const superU = await mkUser('super', Role.SUPER_ADMIN, teamA.id);

    const HTML = '<html><head><meta charset="utf-8"></head><body dir="ltr"><div class="elementToProof"><br></div><div id="appendonsend"></div><div style="font-size:12pt;margin-top:1em;margin-bottom:1em">Hi Mannan,</div><div style="font-size:12pt"><b>Please</b> share the pool.</div></body></html>';
    const mkConv = async (owner: Awaited<ReturnType<typeof mkUser>>, n: number, subject: string) => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const email = `r${i}-${subject.replace(/\W/g, '')}+${stamp}@gmail.com`;
        const c = await prisma.contact.create({ data: { organizationId: org.id, workspaceId: owner.w.id, primaryEmail: email, name: `Recruiter ${i}` } });
        const conv = await prisma.conversation.create({ data: { organizationId: org.id, workspaceId: owner.w.id, ownerId: owner.u.id, contactId: c.id, recipientEmail: email, subject: `${subject} ${i}`, emailProviderAccountId: owner.a.id, gmailThreadId: `QTR-${subject}-${i}-${stamp}`, messageCount: 1, firstMessageAt: new Date(), lastMessageAt: new Date(Date.now() - i * 1000), unread: true } });
        await prisma.conversationMessage.create({ data: { conversationId: conv.id, gmailThreadId: conv.gmailThreadId!, direction: 'INBOUND', classification: 'HUMAN_REPLY', senderEmail: email, senderName: `Recruiter ${i}`, recipientEmail: owner.a.emailAddress, cc: [], bcc: [], sentAt: new Date(), status: 'RECEIVED', htmlBody: HTML, plainTextBody: 'Hi Mannan, Please share the pool.' } });
        out.push(conv.id);
      }
      return out;
    };
    const opAConvs = await mkConv(opA, 4, 'Drive');
    const opBConvs = await mkConv(opB, 2, 'Other');
    await mkConv(adminA, 1, 'Mine');

    const api = async (token: string, method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { cookie: `next-auth.session-token=${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

    // ── API ──────────────────────────────────────────────────────────
    const mine = (await api(adminA.token, 'GET', '/api/inbox?filter=all')).body;
    check('Admin: "my inbox" has only their own 1 reply, and is told Team replies exists', mine.total === 1 && mine.canSeeTeam === true, [mine.total, mine.canSeeTeam]);
    const team = (await api(adminA.token, 'GET', '/api/inbox?filter=all&scope=team')).body;
    check('Admin: Team replies = own team (opA 4 + own 1 = 5), not the other team', team.total === 5 && team.owners.length === 2, [team.total, team.owners]);
    check('rows say whose mailbox they landed in', team.conversations.some((c: any) => c.mailbox?.emailAddress?.startsWith('opA-box')));
    const only = (await api(adminA.token, 'GET', `/api/inbox?filter=all&scope=team&ownerId=${opA.u.id}`)).body;
    check('owner filter narrows to opA (4)', only.total === 4, only.total);
    const sup = (await api(superU.token, 'GET', '/api/inbox?filter=all&scope=team')).body;
    check('Super Admin: Team replies = the whole company (7)', sup.total === 7 && sup.owners.length === 3, [sup.total, sup.owners?.length]);
    const op = (await api(opA.token, 'GET', '/api/inbox?filter=all&scope=team')).body;
    check('Operator asking for scope=team just gets their own inbox, canSeeTeam false', op.total === 4 && op.canSeeTeam === false, [op.total, op.canSeeTeam]);
    check('Admin can open a colleague\'s conversation (200), not the other team\'s (403)', (await api(adminA.token, 'GET', `/api/conversations/${opAConvs[0]}`)).status === 200 && (await api(adminA.token, 'GET', `/api/conversations/${opBConvs[0]}`)).status === 403);
    const det = (await api(adminA.token, 'GET', `/api/conversations/${opAConvs[0]}`)).body;
    const body = (det.messages ?? det.conversation?.messages)?.[0];
    check('message body starts at the first word (empty Outlook block removed)', !!body && !/elementToProof|appendonsend/.test(body.bodyMain) && /Hi Mannan/.test(body.bodyMain), body?.bodyMain?.slice(0, 200));
    const bulk = await api(adminA.token, 'POST', '/api/inbox/bulk', { ids: [opAConvs[1], opBConvs[0]], action: 'resolve' });
    check('Admin can resolve a colleague\'s reply in bulk, the other team\'s is skipped', bulk.body?.updated === 1 && (await prisma.conversation.findUnique({ where: { id: opAConvs[1] } }))?.status === 'RESOLVED' && (await prisma.conversation.findUnique({ where: { id: opBConvs[0] } }))?.status !== 'RESOLVED', bulk.body);
    check('Admin cannot tag a colleague\'s reply in bulk (tags belong to a workspace)', (await api(adminA.token, 'POST', '/api/inbox/bulk', { ids: [opAConvs[2]], action: 'tag', tagName: 'x' })).status === 404);

    // ── Chrome ──────────────────────────────────────────────────────────
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setCookie({ name: 'next-auth.session-token', value: adminA.token, domain: 'localhost', path: '/' });
    await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle2', timeout: 180_000 });
    await page.waitForSelector('[data-scope="team"]', { timeout: 90_000 });
    check('the Inbox shows a "Team replies" tab for the admin', true);
    await page.click('[data-scope="team"]');
    await page.waitForFunction(() => /Mailbox of/i.test(document.body.innerText), { timeout: 30_000 });
    check('Team replies shows the "Mailbox of" filter', true);
    await page.select('select[aria-label="Mailbox owner"]', opA.u.id);
    await sleep(2000);
    const text = await page.$eval('body', (b) => (b as HTMLElement).innerText);
    check('the list now holds opA\'s replies only', /Drive 0/.test(text) && !/Mine 0/.test(text), text.slice(0, 200));
    await page.goto(`${BASE}/inbox/${opAConvs[0]}`, { waitUntil: 'networkidle2', timeout: 180_000 });
    await page.waitForSelector('iframe[title="Message"]', { timeout: 60_000 });
    await sleep(1500);
    const frameText = await page.$eval('iframe[title="Message"]', (f) => (f as HTMLIFrameElement).contentDocument?.body?.innerText ?? '');
    check('the colleague\'s reply opens for the admin and reads "Hi Mannan,"', /^Hi Mannan,/.test(frameText.trim()), frameText.slice(0, 80));
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/team-reply.png` });
  } finally {
    await browser.close();
    await cleanup(org.id).catch((e) => console.error('cleanup', e));
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
