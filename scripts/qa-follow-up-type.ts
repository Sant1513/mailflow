/**
 * Real check (laptop standby + running dev server): the follow-up type choice ("same thread" / "individual new email"),
 * the subject rule, the plan for each type, and the page. Throwaway admin, workspace, mailbox and a finished send.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-follow-up-type.ts
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
  const u = await prisma.user.create({ data: { organizationId: org.id, googleId: `qa-fu-${tag}`, email: `qa-fu-${tag}@masaischool.com`, name: 'QA Follower', role: Role.SUPER_ADMIN } });
  const w = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: u.id, name: 'QA follow-up ws' } });
    const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
  const acc = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: w.id, userId: u.id, emailAddress: u.email, status: 'CONNECTED', refreshTokenEnc: 'x' } });
  const parent = await prisma.recruiterBlast.create({ data: { organizationId: org.id, workspaceId: w.id, createdById: u.id, name: 'QA parent', mode: 'INDIVIDUAL', subject: 'Test followup', html: '<p>Hi</p>', plainText: 'Hi', body: 'Hi', columns: ['Email'], emailColumn: 'Email', accountIds: [acc.id], status: 'COMPLETED', startedAt: new Date(), completedAt: new Date() } });
  const g = await prisma.recruiterBlastGroup.create({ data: { blastId: parent.id, seq: 1, status: 'SENT', recipientCount: 1, accountId: acc.id, fromEmail: u.email, gmailThreadId: 'T-qa', messageIdHeader: '<qa@mail.gmail.com>', sentAt: new Date() } });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: parent.id, email: `qa.fu.${tag}@gmail.com`, name: 'R', data: { Email: `qa.fu.${tag}@gmail.com` }, status: 'SENT', groupId: g.id, sentAt: new Date() } });
  const cookie = `next-auth.session-token=${token}`;
  const call = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const made = await call('POST', '/api/recruiter-follow-ups', { parentId: parent.id, segments: ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED', 'NO_REPLY_UNKNOWN'] });
    check('a follow-up draft is created', made.status === 200 && !!made.body?.id, made);
    console.log('recipients in the draft:', made.body?.recipients);
    const id = made.body.id as string;
    const fresh = await prisma.recruiterBlast.findUniqueOrThrow({ where: { id } });
    check('it starts as "same thread" with the original subject, unchanged', fresh.followUpMode === 'THREAD' && fresh.subject === 'Test followup', fresh.subject);

    const edit = await call('PATCH', `/api/recruiter-blasts/${id}`, { subject: 'Something else' });
    check('in same-thread mode a changed subject is put back to the original', edit.status === 200 && (await prisma.recruiterBlast.findUniqueOrThrow({ where: { id } })).subject === 'Test followup', edit);

    const sw = await call('PATCH', `/api/recruiter-blasts/${id}`, { followUpMode: 'NEW' });
    check('switching to "individual new email" is saved', sw.status === 200 && (await prisma.recruiterBlast.findUniqueOrThrow({ where: { id } })).followUpMode === 'NEW', sw);
    const own = await call('PATCH', `/api/recruiter-blasts/${id}`, { subject: 'A brand new subject' });
    check('…and then the subject can be changed', own.status === 200 && (await prisma.recruiterBlast.findUniqueOrThrow({ where: { id } })).subject === 'A brand new subject', own);

    const planNew = await call('POST', `/api/recruiter-blasts/${id}/check`, {});
    check('the check for a new email says nothing continues the old thread', planNew.status === 200 && (planNew.body?.followUp?.replying ?? 0) === 0, planNew.body?.followUp);

    const back = await call('PATCH', `/api/recruiter-blasts/${id}`, { followUpMode: 'THREAD' });
    const restored = await prisma.recruiterBlast.findUniqueOrThrow({ where: { id } });
    check('switching back to the same thread restores the original subject', back.status === 200 && restored.followUpMode === 'THREAD' && restored.subject === 'Test followup', restored.subject);
    const planThread = await call('POST', `/api/recruiter-blasts/${id}/check`, {});
    check('the check for the same thread counts the email as continuing the thread', planThread.status === 200 && planThread.body?.followUp?.replying === 1, planThread.body?.followUp);

    const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 1100 });
    await page.setCookie({ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/' });
    await page.goto(`${BASE}/recruiter-send/${id}`, { waitUntil: 'networkidle2', timeout: 120_000 });
    await page.waitForSelector('[data-follow-up-type]', { timeout: 90_000 });
    const radios = async () => page.evaluate(() => [...document.querySelectorAll('[data-follow-up-type]')].map((f) => ({ checked: (f.querySelector('input:checked') as HTMLInputElement | null)?.parentElement?.textContent?.slice(0, 30) })));
    check('the page asks how to send the follow-up (same thread is selected)', /same thread/i.test((await radios())[0]?.checked ?? ''), await radios());
    const subjectLocked = () => page.evaluate(() => (document.querySelector('input[maxlength="300"]') as HTMLInputElement | null)?.readOnly);
    check('the subject box is locked for a same-thread follow-up', (await subjectLocked()) === true);
    page.on('response', async (r) => { if (r.request().method() === 'PATCH') console.log('PATCH', r.status(), (r.request().postData() ?? '').slice(0, 160)); });
    await page.evaluate(() => (document.querySelectorAll('[data-follow-up-type] input[type=radio]')[1] as HTMLInputElement).click());
    await page.waitForFunction(() => (document.querySelector('input[maxlength="300"]') as HTMLInputElement | null)?.readOnly === false, { timeout: 15_000 });
    check('choosing "individual new email" unlocks the subject', (await subjectLocked()) === false);
    await new Promise((r) => setTimeout(r, 3500));
    check('…and the choice is saved', (await prisma.recruiterBlast.findUniqueOrThrow({ where: { id } })).followUpMode === 'NEW');
    await page.screenshot({ path: process.env.SHOT ?? 'qa-follow-up-type.png' });
    await browser.close();
  } finally {
    await prisma.recruiterBlastRecipient.deleteMany({ where: { blast: { workspaceId: w.id } } });
    await prisma.recruiterBlastGroup.deleteMany({ where: { blast: { workspaceId: w.id } } });
    await prisma.recruiterBlast.deleteMany({ where: { workspaceId: w.id, parentBlastId: { not: null } } });
    await prisma.recruiterBlast.deleteMany({ where: { workspaceId: w.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } }).catch(() => undefined);
    await prisma.emailProviderAccount.deleteMany({ where: { userId: u.id } });
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
