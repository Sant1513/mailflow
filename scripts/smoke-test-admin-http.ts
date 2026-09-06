/**
 * Phase 6 HTTP smoke test — §9 view-as, §127 analytics pages, §130 retention.
 *
 * Runs against a live `next dev`/`next start` with real NextAuth database
 * sessions for throwaway fixture users (same approach as smoke-test-http.ts),
 * so it exercises requireSession → applyViewAs → requireCanWrite exactly as
 * a browser would. Everything it creates is deleted at the end.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/smoke-test-admin-http.ts
 */
import 'dotenv/config';
import { prisma } from '../lib/db/client';
import { signViewAs } from '../lib/auth/viewAs';
import { Role } from '@prisma/client';
import crypto from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SESSION_COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
const VIEW_AS = 'mailflow.view-as';

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
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* HTML */
  }
  const setCookies: string[] = (res.headers as any).getSetCookie?.() ?? [];
  return { status: res.status, body, text, setCookies, location: res.headers.get('location') };
}

function cookieFrom(setCookies: string[], name: string): string | null {
  const line = setCookies.find((c) => c.startsWith(`${name}=`));
  if (!line) return null;
  return line.split(';')[0] ?? null;
}

async function main() {
  console.log(`=== MailFlow Phase 6 admin HTTP smoke test against ${BASE_URL} ===\n`);
  const stamp = Date.now();

  const org = await prisma.organization.upsert({
    where: { allowedDomain: 'masaischool.com' },
    update: {},
    create: { name: 'Masai School', allowedDomain: 'masaischool.com' },
  });

  const admin = await prisma.user.create({
    data: { organizationId: org.id, googleId: `p6-admin-${stamp}`, email: `p6-admin+${stamp}@masaischool.com`, name: 'P6 Super Admin', role: Role.SUPER_ADMIN },
  });
  const adminWs = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: 'P6 Admin WS' } });
  const operator = await prisma.user.create({
    data: { organizationId: org.id, googleId: `p6-op-${stamp}`, email: `p6-op+${stamp}@masaischool.com`, name: 'P6 Operator', role: Role.OPERATOR },
  });
  const opWs = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: operator.id, name: 'P6 Operator WS' } });
  const adminDataset = await prisma.dataset.create({
    data: { organizationId: org.id, workspaceId: adminWs.id, ownerId: admin.id, name: `P6 Admin Dataset ${stamp}` },
  });
  const opDataset = await prisma.dataset.create({
    data: { organizationId: org.id, workspaceId: opWs.id, ownerId: operator.id, name: `P6 Operator Dataset ${stamp}` },
  });
  // A workspace in ANOTHER organization — must never be viewable.
  const foreignOrg = await prisma.organization.upsert({
    where: { allowedDomain: `p6-foreign-${stamp}.example` },
    update: {},
    create: { name: 'Foreign', allowedDomain: `p6-foreign-${stamp}.example` },
  });
  const foreignUser = await prisma.user.create({
    data: { organizationId: foreignOrg.id, googleId: `p6-foreign-${stamp}`, email: `p6-foreign+${stamp}@example.com`, name: 'Foreign', role: Role.OPERATOR },
  });
  const foreignWs = await prisma.workspace.create({ data: { organizationId: foreignOrg.id, ownerId: foreignUser.id, name: 'Foreign WS' } });

  const adminCookie = await createSessionFor(admin.id);
  const opCookie = await createSessionFor(operator.id);

  try {
    console.log('-- §9 view-as: authorisation --');
    let r = await call('/api/admin/view-as', opCookie, { method: 'POST', body: JSON.stringify({ workspaceId: adminWs.id }) });
    check('operator cannot enter view-as (403)', r.status === 403, r.body);
    r = await call('/api/admin/view-as', null, { method: 'POST', body: JSON.stringify({ workspaceId: opWs.id }) });
    check('anonymous cannot enter view-as (401)', r.status === 401, r.body);
    r = await call('/api/admin/view-as', adminCookie, { method: 'POST', body: JSON.stringify({ workspaceId: foreignWs.id }) });
    check('super admin cannot view a workspace outside the org (404)', r.status === 404, r.body);
    r = await call('/api/admin/view-as', adminCookie, { method: 'POST', body: JSON.stringify({ workspaceId: adminWs.id }) });
    check('viewing your own workspace is a no-op (viewingAs null)', r.status === 200 && r.body?.viewingAs === null, r.body);

    console.log('-- §9 view-as: enter --');
    r = await call('/api/admin/view-as', adminCookie, { method: 'POST', body: JSON.stringify({ workspaceId: opWs.id }) });
    check('super admin enters view-as (200)', r.status === 200 && r.body?.viewingAs?.ownerEmail === operator.email, r.body);
    const viewCookie = cookieFrom(r.setCookies, VIEW_AS);
    check('response sets a signed view-as cookie', Boolean(viewCookie && (viewCookie.split('=')[1] ?? '').split('.').length === 3), r.setCookies);
    check('cookie is HttpOnly', r.setCookies.some((c) => c.startsWith(`${VIEW_AS}=`) && /httponly/i.test(c)), r.setCookies);
    const viewing = `${adminCookie}; ${viewCookie}`;

    r = await call('/api/admin/view-as', viewing);
    check('GET reflects the viewed workspace', r.body?.viewingAs?.workspaceId === opWs.id, r.body);

    r = await call('/api/datasets', viewing);
    check('datasets are scoped to the viewed workspace', r.status === 200 && r.body?.datasets?.some((d: any) => d.id === opDataset.id), r.body);
    r = await call('/api/datasets', adminCookie);
    check('…and not without the cookie', r.status === 200 && !r.body?.datasets?.some((d: any) => d.id === opDataset.id), r.body);

    r = await call('/api/datasets', viewing, { method: 'POST', body: JSON.stringify({ name: 'should not exist' }) });
    check('writes are refused while viewing (403 read-only)', r.status === 403 && /read-only/i.test(r.body?.error ?? ''), r.body);
    const stray = await prisma.dataset.findFirst({ where: { workspaceId: opWs.id, name: 'should not exist' } });
    check('…and nothing was written', stray === null);

    r = await call('/dashboard', viewing);
    check('dashboard renders under view-as (200)', r.status === 200, r.status);
    check('dashboard shows the VIEWING WORKSPACE AS banner', /Viewing workspace as/i.test(r.text) && r.text.includes(operator.email));
    check('dashboard is titled for the viewed owner', r.text.includes('P6 Operator'));

    const tampered = `${adminCookie}; ${VIEW_AS}=${opWs.id}.${Date.now() + 100000}.forgedsignature`;
    r = await call('/api/admin/view-as', tampered);
    check('a forged cookie is ignored', r.status === 200 && r.body?.viewingAs === null, r.body);
    // A validly-signed cookie pointing at the admin's workspace, presented by an operator.
    const opWithCookie = `${opCookie}; ${VIEW_AS}=${signViewAs(adminWs.id)}`;
    r = await call('/api/datasets', opWithCookie);
    check('the cookie does nothing for a non-super-admin', r.status === 200 && !r.body?.datasets?.some((d: any) => d.id === adminDataset.id) && r.body?.datasets?.some((d: any) => d.id === opDataset.id), r.body);

    console.log('-- §9 view-as: exit --');
    r = await call('/api/admin/view-as', viewing, { method: 'DELETE' });
    check('exit view (200)', r.status === 200 && r.body?.viewingAs === null, r.body);
    const cleared = r.setCookies.find((c) => c.startsWith(`${VIEW_AS}=`));
    check('exit clears the cookie (Max-Age=0)', Boolean(cleared && /max-age=0/i.test(cleared)), r.setCookies);
    const trail = await prisma.auditLog.findMany({ where: { actorId: admin.id, action: { in: ['ADMIN_VIEW_WORKSPACE_ENTER', 'ADMIN_VIEW_WORKSPACE_EXIT'] } }, orderBy: { createdAt: 'asc' } });
    check('enter and exit are both audited against the workspace', trail.map((t) => t.action).join(',') === 'ADMIN_VIEW_WORKSPACE_ENTER,ADMIN_VIEW_WORKSPACE_EXIT' && trail.every((t) => t.targetId === opWs.id), trail);

    console.log('-- §127 analytics pages --');
    r = await call('/admin/organization?days=7', adminCookie);
    check('organization analytics renders (200)', r.status === 200, r.status);
    check('…with all five §127 charts/tables', ['Emails by day', 'Replies by day', 'Failure rate', 'Campaign performance', 'User activity'].every((s) => r.text.includes(s)));
    check('…and the 7d period is selected', r.text.includes('Active (7d)'));
    r = await call('/admin/organization?days=9999', adminCookie);
    check('unsupported period falls back to 30d', r.status === 200 && r.text.includes('Active (30d)'));
    r = await call('/admin/organization', opCookie);
    check('operator is redirected away from admin analytics', r.status >= 300 && r.status < 400 && (r.location ?? '').includes('/dashboard'), { status: r.status, location: r.location });
    r = await call('/dashboard', opCookie);
    check('operator dashboard renders the §86 sections', r.status === 200 && ['Emails sent', 'Follow-ups due', 'Recent batches', 'Recent conversations', 'Recent activity'].every((s) => r.text.includes(s)));

    console.log('-- §130 retention --');
    r = await call('/api/admin/retention', opCookie);
    check('operator cannot read the policy (403)', r.status === 403, r.body);
    r = await call('/api/admin/retention', adminCookie);
    check('default policy keeps everything forever', r.status === 200 && r.body?.policy?.messageBodyDays === null && r.body?.enforcement === 'none', r.body);
    check('preview is all zeros with no policy', r.body?.preview?.messageBodies === 0 && r.body?.preview?.auditLogs === 0, r.body);
    r = await call('/api/admin/retention', adminCookie, { method: 'PUT', body: JSON.stringify({ messageBodyDays: 7, emailJobBodyDays: null, auditLogDays: null }) });
    check('a 7-day window is rejected (400)', r.status === 400, r.body);
    const draft = { messageBodyDays: 180, emailJobBodyDays: null, auditLogDays: 30 };
    r = await call(`/api/admin/retention?preview=${encodeURIComponent(JSON.stringify(draft))}`, adminCookie);
    check('draft preview returns counts without saving', r.status === 200 && typeof r.body?.preview?.auditLogs === 'number' && r.body?.policy?.messageBodyDays === null, r.body);
    r = await call('/api/admin/retention', viewing, { method: 'PUT', body: JSON.stringify(draft) });
    check('cannot change the policy while viewing as (403)', r.status === 403, r.body);
    r = await call('/api/admin/retention', adminCookie, { method: 'PUT', body: JSON.stringify(draft) });
    check('valid policy saves (200)', r.status === 200 && r.body?.policy?.messageBodyDays === 180 && r.body?.policy?.auditLogDays === 30, r.body);
    check('…recording who set it', r.body?.policy?.updatedBy === 'P6 Super Admin', r.body?.policy);
    const audit = await prisma.auditLog.findFirst({ where: { actorId: admin.id, action: 'RETENTION_POLICY_UPDATE' } });
    check('policy change is audited with a diff', Boolean(audit) && (audit?.metadata as any)?.diff?.messageBodyDays?.to === 180, audit?.metadata);
    const stillThere = await prisma.auditLog.count({ where: { organizationId: org.id } });
    check('saving a policy deleted nothing', stillThere > 0);
    r = await call('/admin/system-settings', adminCookie);
    check('system settings page renders retention UI', r.status === 200 && r.text.includes('Data retention') && r.text.includes('Runtime configuration'));
  } finally {
    console.log('\n-- cleanup --');
    await prisma.retentionPolicy.deleteMany({ where: { organizationId: org.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [admin.id, operator.id] } } });
    await prisma.session.deleteMany({ where: { userId: { in: [admin.id, operator.id] } } });
    await prisma.dataset.deleteMany({ where: { id: { in: [opDataset.id, adminDataset.id] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [adminWs.id, opWs.id, foreignWs.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, operator.id, foreignUser.id] } } });
    await prisma.organization.deleteMany({ where: { id: foreignOrg.id } });
    await prisma.$disconnect();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
