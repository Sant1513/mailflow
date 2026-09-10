/**
 * §36 approval workflow HTTP smoke test: submit → approvers list/search →
 * approve/reject with reason + remarks → audit + status → dashboard chart.
 *
 * Fixture users have no connected Gmail, so the request/decision emails are
 * recorded as SKIPPED with the reason — the same code path a real mailbox
 * takes, minus the send. (The in-thread send itself is the conversation
 * reply path, verified live in Phase 5.)
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/smoke-test-approvals-http.ts
 */
import 'dotenv/config';
import { prisma } from '../lib/db/client';
import { Role } from '@prisma/client';
import crypto from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SESSION_COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

async function createSessionFor(userId: string) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken, userId, expires: new Date(Date.now() + 3600_000) } });
  return `${SESSION_COOKIE}=${sessionToken}`;
}

async function call(path: string, cookie: string | null, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML */
  }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`=== MailFlow approvals HTTP smoke test against ${BASE_URL} ===\n`);
  const stamp = Date.now();
  const org = await prisma.organization.upsert({ where: { allowedDomain: 'masaischool.com' }, update: {}, create: { name: 'Masai School', allowedDomain: 'masaischool.com' } });

  const mk = async (tag: string, role: Role) => {
    const u = await prisma.user.create({ data: { organizationId: org.id, googleId: `apr-${tag}-${stamp}`, email: `apr-${tag}+${stamp}@masaischool.com`, name: `Apr ${tag}`, role } });
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: u.id, name: `Apr ${tag} WS` } });
    return { u, ws, cookie: await createSessionFor(u.id) };
  };
  const requester = await mk('requester', Role.OPERATOR);
  const superAdmin = await mk('super', Role.SUPER_ADMIN);
  const wsAdmin = await mk('wsadmin', Role.ADMIN);
  const viewer = await mk('viewer', Role.VIEWER);
  // wsAdmin is a member of the requester's workspace → they are an approver there.
  await prisma.workspaceMember.create({ data: { workspaceId: requester.ws.id, userId: wsAdmin.u.id, role: Role.ADMIN } });

  const dataset = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: requester.ws.id, ownerId: requester.u.id, name: `Apr dataset ${stamp}` } });
  await prisma.datasetColumn.create({ data: { datasetId: dataset.id, key: 'Email', label: 'Email', type: 'EMAIL', order: 0 } });
  const rec = await prisma.record.create({ data: { datasetId: dataset.id, data: { Email: `s+${stamp}@example.com` } } });
  const template = await prisma.template.create({ data: { organizationId: org.id, workspaceId: requester.ws.id, ownerId: requester.u.id, name: `Apr template ${stamp}` } });
  const version = await prisma.templateVersion.create({ data: { templateId: template.id, version: 1, subject: 'Hello {{Email}}', html: '<p>Hi</p>', variables: ['Email'], createdById: requester.u.id } });
  const mkCampaign = async (name: string) => {
    const c = await prisma.campaign.create({
      data: { organizationId: org.id, workspaceId: requester.ws.id, name, datasetId: dataset.id, templateId: template.id, templateVersionId: version.id, createdById: requester.u.id },
    });
    await prisma.campaignRecord.create({ data: { campaignId: c.id, recordId: rec.id } });
    return c;
  };
  const c1 = await mkCampaign(`Apr campaign A ${stamp}`);
  const c2 = await mkCampaign(`Apr campaign B ${stamp}`);

  try {
    console.log('-- submit --');
    let r = await call(`/api/campaigns/${c1.id}/approval`, requester.cookie, { method: 'POST', body: JSON.stringify({ action: 'SUBMIT' }) });
    check('requester submits (200, PENDING_APPROVAL)', r.status === 200 && r.json?.campaign?.status === 'PENDING_APPROVAL', r.json);
    check('submittedAt recorded', !!r.json?.campaign?.submittedAt, r.json?.campaign);
    check('request email attempted and its outcome recorded (no mailbox → SKIPPED)', typeof r.json?.emailStatus === 'string' && r.json.emailStatus.startsWith('SKIPPED'), r.json?.emailStatus);
    await call(`/api/campaigns/${c2.id}/approval`, requester.cookie, { method: 'POST', body: JSON.stringify({ action: 'SUBMIT' }) });
    const emailAudit = await prisma.auditLog.count({ where: { targetId: c1.id, action: 'CAMPAIGN_APPROVAL_EMAIL' } });
    check('email attempt audited', emailAudit === 1, emailAudit);

    console.log('-- approvals list --');
    r = await call('/api/approvals', viewer.cookie);
    check('viewer cannot list approvals (403)', r.status === 403, r.status);
    r = await call('/api/approvals', requester.cookie);
    check('operator cannot list approvals (403)', r.status === 403, r.status);
    r = await call('/api/approvals', superAdmin.cookie);
    check('super admin sees both pending requests org-wide', r.status === 200 && r.json?.scope === 'organization' && r.json.requests.filter((x: any) => [c1.id, c2.id].includes(x.id)).length === 2, r.json?.requests?.length);
    check('counts reflect pending', r.json?.counts?.pending >= 2, r.json?.counts);
    check('rows carry requester, recipients, template and canDecide', r.json?.requests.every((x: any) => x.requester?.email && typeof x.recipients === 'number' && x.template && x.canDecide === true), r.json?.requests?.[0]);
    r = await call(`/api/approvals?q=campaign%20B%20${stamp}`, superAdmin.cookie);
    check('search narrows to one', r.json?.requests?.length === 1 && r.json.requests[0].id === c2.id, r.json?.requests?.map((x: any) => x.name));
    r = await call(`/api/approvals?q=${encodeURIComponent(requester.u.email)}`, superAdmin.cookie);
    check('search by requester email', r.json?.requests?.length === 2, r.json?.requests?.length);
    r = await call('/api/approvals', wsAdmin.cookie);
    check('workspace admin sees only their workspace scope', r.status === 200 && r.json?.scope === 'workspace', r.json?.scope);

    console.log('-- decide --');
    r = await call(`/api/campaigns/${c1.id}/approval`, requester.cookie, { method: 'POST', body: JSON.stringify({ action: 'APPROVE' }) });
    check('operator cannot approve (403)', r.status === 403, r.status);
    r = await call(`/api/campaigns/${c2.id}/approval`, superAdmin.cookie, { method: 'POST', body: JSON.stringify({ action: 'REJECT' }) });
    check('reject without a reason is refused (400)', r.status === 400, r.json);
    r = await call(`/api/campaigns/${c1.id}/approval`, superAdmin.cookie, { method: 'POST', body: JSON.stringify({ action: 'APPROVE', remarks: 'Checked the list' }) });
    check('super admin approves with remarks', r.status === 200 && r.json?.campaign?.status === 'APPROVED' && r.json.campaign.approvalRemarks === 'Checked the list', r.json?.campaign);
    check('decision email attempted (no mailbox → SKIPPED)', typeof r.json?.emailStatus === 'string' && r.json.emailStatus.startsWith('SKIPPED'), r.json?.emailStatus);
    r = await call(`/api/campaigns/${c2.id}/approval`, superAdmin.cookie, { method: 'POST', body: JSON.stringify({ action: 'REJECT', reason: 'Subject is wrong', remarks: 'talk to them' }) });
    check('reject with reason + remarks', r.status === 200 && r.json?.campaign?.status === 'REJECTED' && r.json.campaign.rejectionReason === 'Subject is wrong' && !!r.json.campaign.rejectedAt, r.json?.campaign);
    const audits = await prisma.auditLog.findMany({ where: { targetId: { in: [c1.id, c2.id] }, action: { in: ['CAMPAIGN_APPROVED', 'CAMPAIGN_REJECTED', 'CAMPAIGN_SUBMITTED_FOR_APPROVAL'] } } });
    check('submit/approve/reject audited', audits.length === 4 && audits.some((a) => a.action === 'CAMPAIGN_REJECTED' && (a.metadata as any).reason === 'Subject is wrong'), audits.map((a) => a.action));

    r = await call('/api/approvals?status=approved', superAdmin.cookie);
    check('approved tab lists the approved campaign with reviewer', r.json?.requests?.some((x: any) => x.id === c1.id && x.reviewer === superAdmin.u.name && x.remarks === 'Checked the list'), r.json?.requests?.find((x: any) => x.id === c1.id));
    r = await call('/api/approvals?status=rejected', superAdmin.cookie);
    check('rejected tab carries the reason', r.json?.requests?.some((x: any) => x.id === c2.id && x.reason === 'Subject is wrong'), r.json?.requests?.find((x: any) => x.id === c2.id));

    // Resubmit after rejection clears the decision.
    r = await call(`/api/campaigns/${c2.id}/approval`, requester.cookie, { method: 'POST', body: JSON.stringify({ action: 'SUBMIT' }) });
    check('rejected campaign can be resubmitted; reason cleared', r.status === 200 && r.json?.campaign?.status === 'PENDING_APPROVAL' && r.json.campaign.rejectionReason === null && r.json.campaign.rejectedAt === null, r.json?.campaign);
    r = await call(`/api/campaigns/${c2.id}/approval`, wsAdmin.cookie, { method: 'POST', body: JSON.stringify({ action: 'APPROVE' }) });
    check('workspace admin (member) can approve in that workspace', r.status === 200 && r.json?.campaign?.status === 'APPROVED', r.json);

    console.log('-- pages --');
    const page = await fetch(`${BASE_URL}/approvals`, { headers: { Cookie: superAdmin.cookie }, redirect: 'manual' });
    check('approvals page renders (200)', page.status === 200, page.status);
    const dash = await fetch(`${BASE_URL}/dashboard`, { headers: { Cookie: requester.cookie }, redirect: 'manual' }).then((x) => x.text());
    check('dashboard shows the approvals report', dash.includes('Campaign approvals'), dash.length);
    const orgPage = await fetch(`${BASE_URL}/admin/organization?days=7`, { headers: { Cookie: superAdmin.cookie }, redirect: 'manual' }).then((x) => x.text());
    check('organization analytics shows the approvals chart', orgPage.includes('Campaign approvals'), orgPage.length);
    const campaignPage = await fetch(`${BASE_URL}/campaigns/${c1.id}`, { headers: { Cookie: requester.cookie }, redirect: 'manual' });
    check('campaign page renders for the requester', campaignPage.status === 200, campaignPage.status);
    const login = await fetch(`${BASE_URL}/login`).then((x) => x.text());
    check('root layout no longer hard-codes dark; theme script present', !/<html[^>]*class="[^"]*\bdark\b/.test(login) && login.includes('mailflow.theme'), login.slice(0, 200));
  } finally {
    console.log('\n-- cleanup --');
    const ids = [requester.u.id, superAdmin.u.id, wsAdmin.u.id, viewer.u.id];
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.campaignRecord.deleteMany({ where: { campaignId: { in: [c1.id, c2.id] } } });
    await prisma.campaign.deleteMany({ where: { id: { in: [c1.id, c2.id] } } });
    await prisma.templateVersion.deleteMany({ where: { templateId: template.id } });
    await prisma.template.deleteMany({ where: { id: template.id } });
    await prisma.dataset.deleteMany({ where: { id: dataset.id } });
    await prisma.contact.deleteMany({ where: { workspaceId: requester.ws.id } });
    await prisma.workspaceMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workspace.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
