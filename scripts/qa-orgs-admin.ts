/**
 * Real check (laptop standby + running dev server): organisations (teams) end to end.
 * Admin page, approvals with an organisation, and the send-time guard (a send may use only its organisation's mailboxes).
 * Throwaway users/workspaces/mailboxes/organisations in the existing masaischool.com company; everything is removed again.
 *   BASE_URL=http://localhost:3000 npx tsx --env-file=.env scripts/qa-orgs-admin.ts
 */
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { Role, UserStatus } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)?.slice(0, 400)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const tenant = await prisma.organization.findFirstOrThrow({ where: { allowedDomain: 'masaischool.com' } });
  const tag = Date.now();
  const domB = `qa-${tag}.example`; // the second organisation's own domain (unique, so a domain suggestion is deterministic)
  const created = { users: [] as string[], units: [] as string[] };

  const unitA = await prisma.orgUnit.create({ data: { organizationId: tenant.id, name: `QA Alpha ${tag}`, domains: ['masaischool.com'] } });
  const unitB = await prisma.orgUnit.create({ data: { organizationId: tenant.id, name: `QA Beta ${tag}`, domains: [domB] } });
  created.units.push(unitA.id, unitB.id);

  const mk = async (label: string, role: Role, unitId: string | null, opts: { email?: string; status?: UserStatus; mailbox?: string } = {}) => {
    const email = opts.email ?? `qa-og-${label}-${tag}@masaischool.com`;
    const u = await prisma.user.create({ data: { organizationId: tenant.id, orgUnitId: unitId, googleId: `qa-og-${label}-${tag}`, email, name: `QA ${label}`, role, status: opts.status ?? UserStatus.ACTIVE } });
    created.users.push(u.id);
    const w = await prisma.workspace.create({ data: { organizationId: tenant.id, orgUnitId: unitId, ownerId: u.id, name: `QA ${label} ws` } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: u.id, expires: new Date(Date.now() + 3600_000) } });
    const acc = opts.mailbox ? await prisma.emailProviderAccount.create({ data: { organizationId: tenant.id, workspaceId: w.id, userId: u.id, emailAddress: opts.mailbox, status: 'CONNECTED', refreshTokenEnc: 'x' } }) : null;
    return { u, w, token, acc };
  };

  const sa = await mk('sa', Role.SUPER_ADMIN, unitA.id, { mailbox: `qa-og-sa-${tag}@masaischool.com` });
  const adminA = await mk('admina', Role.ADMIN, unitA.id, { mailbox: `qa-og-admina-${tag}@masaischool.com` });
  const adminB = await mk('adminb', Role.ADMIN, unitB.id, { email: `qa-og-adminb-${tag}@${domB}`, mailbox: `qa-og-adminb-${tag}@${domB}` });
  const adminC = await mk('adminc', Role.ADMIN, unitA.id, { mailbox: `qa-og-adminc-${tag}@gmail.com` }); // org A lists only masaischool.com
  const operator = await mk('operator', Role.OPERATOR, unitA.id);
  const movee = await mk('movee', Role.OPERATOR, unitA.id);
  const pendSuggest = await mk('pend1', Role.OPERATOR, null, { email: `qa-og-pend1-${tag}@${domB}`, status: UserStatus.PENDING });
  const pendPlain = await mk('pend2', Role.OPERATOR, null, { status: UserStatus.PENDING });
  const pendApi = await mk('pend3', Role.OPERATOR, null, { status: UserStatus.PENDING });
  const empty = await prisma.orgUnit.create({ data: { organizationId: tenant.id, name: `QA Empty ${tag}`, domains: [] } });
  created.units.push(empty.id);

  // Org B's mailbox is shared as a backup (opted in), the exact case that must never leak into org A's sends.
  const settingsBefore = await prisma.integrationSettings.findUnique({ where: { organizationId: tenant.id } });
  const { updateOrgSettings, getOrgSettings } = await import('../lib/settings/org');
  const cur = await getOrgSettings(tenant.id);
  await updateOrgSettings(tenant.id, { fallbackMailboxes: [...new Set([...cur.fallbackMailboxes, adminB.acc!.id, adminA.acc!.id])] }, sa.u.id);

  const call = async (who: { token: string }, method: string, path: string, body?: unknown) => {
    const r = await fetch(BASE + path, { method, headers: { cookie: `next-auth.session-token=${who.token}`, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    // ---------------- (1) Super Admin: organisations ----------------
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1100 });
    await page.setCookie({ name: 'next-auth.session-token', value: sa.token, domain: 'localhost', path: '/' });
    page.on('dialog', (d) => void d.accept());
    await page.goto(`${BASE}/admin/organisations`, { waitUntil: 'networkidle2', timeout: 120_000 });
    await page.waitForSelector('[data-org-table]', { timeout: 90_000 });
    const tableText = await page.$eval('[data-org-table]', (e) => (e as HTMLElement).innerText);
    check('Organisations page lists the organisations with their sender domains', tableText.includes(`QA Alpha ${tag}`) && tableText.includes('@masaischool.com') && tableText.includes(`QA Beta ${tag}`), tableText.slice(0, 200));
    const nav = await page.evaluate(() => [...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/admin/organisations'));
    check('the sidebar links to Organisations', nav);

    // create through the form
    const newName = `QA Created ${tag}`;
    await page.type('input[placeholder^="e.g. Operations"]', newName);
    await page.type('input[placeholder^="masaischool.com, neevlabs.ai"]', `@Created-${tag}.example, masaischool.com`);
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent === 'Add organisation') as HTMLElement).click());
    let made = null as null | { id: string; domains: string[] };
    for (let i = 0; i < 30 && !made; i++) { await sleep(500); made = await prisma.orgUnit.findFirst({ where: { organizationId: tenant.id, name: newName }, select: { id: true, domains: true } }); }
    if (made) created.units.push(made.id);
    check('creating an organisation saves it with normalised domains', !!made && made.domains.sort().join() === [`created-${tag}.example`, 'masaischool.com'].sort().join(), made);
    const dup = await call(sa, 'POST', '/api/admin/org-units', { name: newName, domains: '' });
    check('a duplicate name is refused (409)', dup.status === 409, dup);
    const edit = await call(sa, 'PATCH', `/api/admin/org-units/${made?.id}`, { name: `${newName} v2`, domains: 'one.example, two.example' });
    const editedRow = await prisma.orgUnit.findUnique({ where: { id: made?.id ?? '' } });
    check('editing renames it and replaces its domains', edit.status === 200 && editedRow?.name === `${newName} v2` && editedRow.domains.join() === 'one.example,two.example', editedRow);
    const delFull = await call(sa, 'DELETE', `/api/admin/org-units/${unitA.id}`);
    check('deleting an organisation that has people is refused (409)', delFull.status === 409 && /Move/.test(delFull.body?.error ?? ''), delFull);
    const delEmpty = await call(sa, 'DELETE', `/api/admin/org-units/${empty.id}`);
    check('deleting an empty organisation works', delEmpty.status === 200 && !(await prisma.orgUnit.findUnique({ where: { id: empty.id } })), delEmpty);
    const delMade = await call(sa, 'DELETE', `/api/admin/org-units/${made?.id}`);
    check('…and so does the one just created', delMade.status === 200, delMade);

    // move a person with the people table (confirm dialog accepted)
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-org-people]', { timeout: 60_000 });
    await page.select(`select[aria-label="Organisation of QA movee"]`, unitB.id);
    let moved = null as null | { orgUnitId: string | null };
    for (let i = 0; i < 30; i++) { await sleep(500); moved = await prisma.user.findUnique({ where: { id: movee.u.id }, select: { orgUnitId: true } }); if (moved?.orgUnitId === unitB.id) break; }
    const mw = await prisma.workspace.findFirst({ where: { ownerId: movee.u.id }, select: { orgUnitId: true } });
    check('the people table moves a person to another organisation', moved?.orgUnitId === unitB.id, moved);
    check('…and their workspace follows', mw?.orgUnitId === unitB.id, mw);
    await page.screenshot({ path: process.env.SHOT_ORGS ?? 'qa-orgs-page.png' });

    // who may use the API
    const asAdmin = await call(adminA, 'GET', '/api/admin/org-units');
    const asOp = await call(operator, 'GET', '/api/admin/org-units');
    check('an Admin and an Operator get 403 from the organisations API', asAdmin.status === 403 && asOp.status === 403, [asAdmin.status, asOp.status]);
    const asAdminMove = await call(adminA, 'PATCH', `/api/admin/users/${operator.u.id}`, { orgUnitId: unitB.id });
    check('only a Super Admin may change a person’s organisation (403)', asAdminMove.status === 403, asAdminMove.status);

    // ---------------- (2) Approvals ----------------
    await page.goto(`${BASE}/approvals?section=users`, { waitUntil: 'networkidle2', timeout: 120_000 });
    await page.waitForSelector(`select[aria-label="Organisation for QA pend1"]`, { timeout: 60_000 });
    const suggested = await page.$eval(`select[aria-label="Organisation for QA pend1"]`, (e) => (e as HTMLSelectElement).value);
    check('a pending person whose domain one organisation lists gets it suggested', suggested === unitB.id, suggested);
    const plainSel = await page.$eval(`select[aria-label="Organisation for QA pend2"]`, (e) => (e as HTMLSelectElement).value);
    const approveDisabled = await page.evaluate(() => { const row = [...document.querySelectorAll('tr')].find((r) => r.textContent?.includes('QA pend2'))!; return (([...row.querySelectorAll('button')].find((b) => b.textContent === 'Approve') as HTMLButtonElement).disabled); });
    check('with no organisation chosen the Approve button is disabled', plainSel === '' && approveDisabled, { plainSel, approveDisabled });
    await page.select(`select[aria-label="Organisation for QA pend2"]`, unitA.id);
    await sleep(300);
    await page.evaluate(() => { const row = [...document.querySelectorAll('tr')].find((r) => r.textContent?.includes('QA pend2'))!; ([...row.querySelectorAll('button')].find((b) => b.textContent === 'Approve') as HTMLElement).click(); });
    let appr = null as null | { status: string; orgUnitId: string | null };
    for (let i = 0; i < 30; i++) { await sleep(500); appr = await prisma.user.findUnique({ where: { id: pendPlain.u.id }, select: { status: true, orgUnitId: true } }); if (appr?.status === 'ACTIVE') break; }
    const apprW = await prisma.workspace.findFirst({ where: { ownerId: pendPlain.u.id }, select: { orgUnitId: true } });
    check('choosing an organisation then Approve activates the person in it', appr?.status === 'ACTIVE' && appr.orgUnitId === unitA.id && apprW?.orgUnitId === unitA.id, { appr, apprW });
    const noOrg = await call(sa, 'PATCH', `/api/admin/users/${pendApi.u.id}`, { status: 'ACTIVE' });
    const still = await prisma.user.findUnique({ where: { id: pendApi.u.id }, select: { status: true } });
    check('API: approving without an organisation is refused (400) and nothing changes', noOrg.status === 400 && /organisation/i.test(noOrg.body?.error ?? '') && still?.status === 'PENDING', noOrg);
    const withOrg = await call(sa, 'PATCH', `/api/admin/users/${pendApi.u.id}`, { status: 'ACTIVE', orgUnitId: unitB.id });
    const after = await prisma.user.findUnique({ where: { id: pendApi.u.id }, select: { status: true, orgUnitId: true } });
    const afterW = await prisma.workspace.findFirst({ where: { ownerId: pendApi.u.id }, select: { orgUnitId: true } });
    check('API: approving with an organisation sets it on the person and their workspace', withOrg.status === 200 && after?.status === 'ACTIVE' && after.orgUnitId === unitB.id && afterW?.orgUnitId === unitB.id, { withOrg: withOrg.status, after, afterW });
    const badOrg = await call(sa, 'PATCH', `/api/admin/users/${operator.u.id}`, { orgUnitId: 'does-not-exist' });
    check('an organisation that does not exist is refused (400)', badOrg.status === 400, badOrg);
    const pendingList = await call(sa, 'GET', '/api/admin/pending-users');
    check('the pending list carries the organisations to choose from', Array.isArray(pendingList.body?.orgUnits) && pendingList.body.orgUnits.some((o: any) => o.id === unitA.id), pendingList.status);

    // ---------------- (3) Send-time guard: Recruiter Bulk Send ----------------
    const made2 = await call(adminA, 'POST', '/api/recruiter-blasts', {});
    const blastId = made2.body?.id as string;
    check('a draft is created as the admin’s own organisation', made2.status === 200 && !!blastId && (await prisma.recruiterBlast.findUnique({ where: { id: blastId } }))?.orgUnitId === unitA.id, made2);
    const detail = await call(adminA, 'GET', `/api/recruiter-blasts/${blastId}`);
    const mailboxIds: string[] = (detail.body?.mailboxes ?? []).map((m: any) => m.id);
    check('the draft shows its organisation and offers only that organisation’s mailboxes', detail.body?.org?.id === unitA.id && mailboxIds.includes(adminA.acc!.id) && !mailboxIds.includes(adminB.acc!.id), { org: detail.body?.org, mailboxIds });
    check('a Super Admin’s organisation list offers every organisation; an Admin’s only their own', (detail.body?.orgOptions ?? []).length === 1 && (await call(sa, 'GET', `/api/recruiter-blasts/${blastId}`)).body?.orgOptions?.length >= 2, detail.body?.orgOptions);
    const orgBBackup = await call(adminA, 'PATCH', `/api/recruiter-blasts/${blastId}`, { accountIds: [adminB.acc!.id] });
    check('choosing another organisation’s opted-in mailbox is refused (400)', orgBBackup.status === 400 && /organisation/i.test(orgBBackup.body?.error ?? ''), orgBBackup);
    const okOwn = await call(adminA, 'PATCH', `/api/recruiter-blasts/${blastId}`, { accountIds: [adminA.acc!.id] });
    check('choosing the organisation’s own mailbox is accepted', okOwn.status === 200, okOwn.status);
    const adminSwitch = await call(adminA, 'PATCH', `/api/recruiter-blasts/${blastId}`, { orgUnitId: unitB.id });
    check('an Admin trying to send as another organisation is refused (403)', adminSwitch.status === 403, adminSwitch);
    const saSwitch = await call(sa, 'PATCH', `/api/recruiter-blasts/${blastId}`, { orgUnitId: unitB.id });
    const row = await prisma.recruiterBlast.findUnique({ where: { id: blastId }, select: { orgUnitId: true, accountIds: true } });
    check('a Super Admin may switch it to another organisation, and the old organisation’s mailboxes are dropped', saSwitch.status === 200 && row?.orgUnitId === unitB.id && !row.accountIds.includes(adminA.acc!.id), { saSwitch: saSwitch.status, row });
    const detailB = await call(sa, 'GET', `/api/recruiter-blasts/${blastId}`);
    const idsB: string[] = (detailB.body?.mailboxes ?? []).map((m: any) => m.id);
    check('…and it then offers only the new organisation’s mailboxes', idsB.includes(adminB.acc!.id) && !idsB.includes(adminA.acc!.id), idsB);
    // A mailbox written straight into the draft (bypassing the API) must still be stopped at start.
    await prisma.recruiterBlast.update({ where: { id: blastId }, data: { orgUnitId: unitA.id, accountIds: [adminB.acc!.id], subject: 'QA subject', body: 'QA body', html: '<p>QA body</p>', plainText: 'QA body' } });
    const start = await call(adminA, 'POST', `/api/recruiter-blasts/${blastId}/start`, {});
    check('start refuses a draft whose mailbox is not in its organisation', start.status >= 400 && /organisation/i.test(JSON.stringify(start.body)), start);
    const stillDraft = await prisma.recruiterBlast.findUnique({ where: { id: blastId }, select: { status: true } });
    check('…and the send stays a draft', stillDraft?.status === 'DRAFT', stillDraft);

    // screenshot of the organisation box on the send page
    const rp = await browser.newPage();
    await rp.setViewport({ width: 1400, height: 1200 });
    await rp.setCookie({ name: 'next-auth.session-token', value: adminA.token, domain: 'localhost', path: '/' });
    await prisma.recruiterBlast.update({ where: { id: blastId }, data: { accountIds: [adminA.acc!.id] } });
    await rp.goto(`${BASE}/recruiter-send/${blastId}`, { waitUntil: 'networkidle2', timeout: 120_000 });
    await rp.waitForSelector('button', { timeout: 60_000 });
    if (!(await rp.$('[data-send-org]'))) {
      await rp.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Send from/.test(x.textContent ?? '') && !/Send from:/.test(x.textContent ?? '')); (b as HTMLElement | undefined)?.click(); });
      await sleep(800);
    }
    const box = await rp.$('[data-send-org]');
    check('the send page shows the “Send as organisation” box', !!box, null);
    if (box) { await box.scrollIntoView(); await rp.screenshot({ path: process.env.SHOT_SEND ?? 'qa-orgs-send.png' }); }
    await rp.close();

    // ---------------- Quick Send ----------------
    const qsBody = (extra: Record<string, unknown> = {}) => ({ mode: 'check', subject: 'QA org check', body: 'Hello {{Name}}', recipients: { kind: 'table', headers: ['Name', 'Email'], rows: [{ Name: 'Pat', Email: `qa.pat.${tag}@gmail.com` }], emailHeader: 'Email' }, ...extra });
    const qsOk = await call(adminA, 'POST', '/api/quick-send', qsBody());
    check('Quick Send check reports the organisation with no problem and the options', qsOk.status === 200 && qsOk.body?.org?.id === unitA.id && qsOk.body.org.problem === null && Array.isArray(qsOk.body.org.options) && qsOk.body.org.options.length === 1, qsOk.body?.org ?? qsOk);
    const qsBad = await call(adminC, 'POST', '/api/quick-send', qsBody());
    check('a mailbox on a domain the organisation does not list gets a problem', qsBad.status === 200 && /sender domains/.test(qsBad.body?.org?.problem ?? ''), qsBad.body?.org ?? qsBad);
    const qsSend = await call(adminC, 'POST', '/api/quick-send', qsBody({ mode: 'send' }));
    check('…and the real send is refused (400)', qsSend.status === 400 && /sender domains/.test(qsSend.body?.error ?? ''), qsSend);
    const qsOther = await call(adminA, 'POST', '/api/quick-send', qsBody({ orgUnitId: unitB.id }));
    check('an Admin asking Quick Send to send as another organisation is refused (403)', qsOther.status === 403, qsOther.status);
    const qsSA = await call(sa, 'POST', '/api/quick-send', qsBody({ orgUnitId: unitB.id }));
    check('a Super Admin sending as another organisation is told their own mailbox is not that organisation’s', qsSA.status === 200 && /belongs to QA Alpha/.test(qsSA.body?.org?.problem ?? ''), qsSA.body?.org ?? qsSA);
    const qsBackups = await call(adminA, 'POST', '/api/quick-send', qsBody());
    check('Quick Send never offers another organisation’s backup mailbox', !(qsBackups.body?.backups ?? []).some((b: any) => b.id === adminB.acc!.id), qsBackups.body?.backups);
  } finally {
    await browser.close();
    const userIds = created.users;
    const ws = (await prisma.workspace.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } })).map((w) => w.id);
    await prisma.recruiterBlastRecipient.deleteMany({ where: { blast: { workspaceId: { in: ws } } } }).catch(() => undefined);
    await prisma.recruiterBlastGroup.deleteMany({ where: { blast: { workspaceId: { in: ws } } } }).catch(() => undefined);
    await prisma.recruiterBlast.deleteMany({ where: { workspaceId: { in: ws } } });
    await prisma.campaign.deleteMany({ where: { workspaceId: { in: ws } } }).catch(() => undefined);
    await prisma.emailProviderAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.workspaceMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.workspace.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.orgUnit.deleteMany({ where: { id: { in: created.units } } });
    await prisma.orgUnit.deleteMany({ where: { organizationId: tenant.id, name: { contains: String(tag) } } });
    if (settingsBefore) await prisma.integrationSettings.update({ where: { organizationId: tenant.id }, data: { settings: settingsBefore.settings as never } });
    else await prisma.integrationSettings.deleteMany({ where: { organizationId: tenant.id } });
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
