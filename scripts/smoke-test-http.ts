/**
 * Full HTTP smoke test against a running `next dev`/`next start` instance,
 * using a real NextAuth database session (created directly, the same way
 * the adapter would after a real Google sign-in) since we don't have Google
 * OAuth credentials configured in this environment yet. Exercises the same
 * requireSession()/requireRole() code paths a real browser session would.
 *
 * Usage: BASE_URL=http://localhost:3001 npx tsx scripts/smoke-test-http.ts
 */
import { prisma } from '../lib/db/client';
import { Role } from '@prisma/client';
import crypto from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3001';
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

// NextAuth prefixes the session cookie with "__Secure-" when served over
// HTTPS (its default `useSecureCookies` follows the site URL's protocol).
const COOKIE_NAME = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';

async function createSessionFor(userId: string) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({
    data: { sessionToken, userId, expires: new Date(Date.now() + 3600_000) },
  });
  return `${COOKIE_NAME}=${sessionToken}`;
}

async function api(path: string, cookie: string | null, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON (redirects, HTML) */
  }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  console.log(`=== MailFlow HTTP smoke test against ${BASE_URL} ===\n`);

  const org = await prisma.organization.upsert({
    where: { allowedDomain: 'masaischool.com' },
    update: {},
    create: { name: 'Masai School', allowedDomain: 'masaischool.com' },
  });

  const operator = await prisma.user.create({
    data: {
      organizationId: org.id,
      googleId: `http-smoke-op-${Date.now()}`,
      email: `http-smoke-op+${Date.now()}@masaischool.com`,
      name: 'HTTP Smoke Operator',
      role: Role.OPERATOR,
    },
  });
  const opWorkspace = await prisma.workspace.create({
    data: { organizationId: org.id, ownerId: operator.id, name: 'HTTP Smoke Workspace' },
  });
  const opCookie = await createSessionFor(operator.id);

  const viewer = await prisma.user.create({
    data: {
      organizationId: org.id,
      googleId: `http-smoke-viewer-${Date.now()}`,
      email: `http-smoke-viewer+${Date.now()}@masaischool.com`,
      name: 'HTTP Smoke Viewer',
      role: Role.VIEWER,
    },
  });
  await prisma.workspace.create({
    data: { organizationId: org.id, ownerId: viewer.id, name: 'Viewer Workspace' },
  });
  const viewerCookie = await createSessionFor(viewer.id);

  const superAdmin = await prisma.user.create({
    data: {
      organizationId: org.id,
      googleId: `http-smoke-admin-${Date.now()}`,
      email: `http-smoke-admin+${Date.now()}@masaischool.com`,
      name: 'HTTP Smoke Super Admin',
      role: Role.SUPER_ADMIN,
    },
  });
  await prisma.workspace.create({
    data: { organizationId: org.id, ownerId: superAdmin.id, name: 'Admin Workspace' },
  });
  const adminCookie = await createSessionFor(superAdmin.id);

  const createdDatasetIds: string[] = [];

  // ── Authenticated page access ──
  console.log('-- Authenticated pages --');
  {
    const r = await api('/dashboard', opCookie);
    check('Signed-in OPERATOR can load /dashboard (200)', r.status === 200);
  }
  {
    const r = await api('/dashboard', null);
    check('Unauthenticated /dashboard redirects (307)', r.status === 307);
  }

  // ── Dataset CRUD as OPERATOR ──
  console.log('\n-- Dataset CRUD (OPERATOR) --');
  {
    const r = await api('/api/datasets', opCookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'HTTP Smoke Dataset' }),
    });
    check('OPERATOR can create a dataset (201)', r.status === 201, r.body);
    if (r.body?.dataset?.id) createdDatasetIds.push(r.body.dataset.id);
  }
  const datasetId = createdDatasetIds[0];
  check('Dataset id captured', !!datasetId);

  {
    const r = await api('/api/datasets', opCookie);
    check('List datasets returns the created one', r.status === 200 && r.body.datasets.some((d: any) => d.id === datasetId));
  }

  // ── VIEWER cannot write (RBAC, §7/§94) ──
  console.log('\n-- RBAC: VIEWER denied writes --');
  {
    const r = await api('/api/datasets', viewerCookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Should be rejected' }),
    });
    check('VIEWER cannot create a dataset (403)', r.status === 403, r.body);
  }
  {
    // VIEWER also cannot see OPERATOR's workspace data at all (different workspace)
    const r = await api(`/api/datasets/${datasetId}`, viewerCookie);
    check('VIEWER cannot read another workspace\'s dataset (403)', r.status === 403, r.body);
  }

  // ── Columns ──
  console.log('\n-- Columns --');
  let emailColumnId: string | null = null;
  {
    const r = await api(`/api/datasets/${datasetId}/columns`, opCookie, {
      method: 'POST',
      body: JSON.stringify({ key: 'Name', label: 'Name', type: 'TEXT' }),
    });
    check('Add TEXT column (201)', r.status === 201, r.body);
  }
  {
    const r = await api(`/api/datasets/${datasetId}/columns`, opCookie, {
      method: 'POST',
      body: JSON.stringify({ key: 'Email', label: 'Email', type: 'EMAIL' }),
    });
    check('Add EMAIL column (201)', r.status === 201, r.body);
    emailColumnId = r.body?.column?.id ?? null;
  }
  {
    // duplicate key should be rejected by the DB unique constraint -> 500 mapped, or ideally 400.
    const r = await api(`/api/datasets/${datasetId}/columns`, opCookie, {
      method: 'POST',
      body: JSON.stringify({ key: 'Email', label: 'Email dup', type: 'EMAIL' }),
    });
    check('Duplicate column key is rejected (not 2xx)', r.status >= 400, r.status);
  }

  // ── Records: create, patch (contact linking), delete ──
  console.log('\n-- Records + contact linking over HTTP --');
  let recordId: string | null = null;
  {
    const r = await api(`/api/datasets/${datasetId}/records`, opCookie, {
      method: 'POST',
      body: JSON.stringify({ data: { Name: 'Rahul Sharma', Email: 'rahul-http@example.com' } }),
    });
    check('Create record (201)', r.status === 201, r.body);
    recordId = r.body?.record?.id ?? null;
  }
  {
    const r = await api(`/api/datasets/${datasetId}`, opCookie);
    check('Dataset detail returns 1 record', r.status === 200 && r.body.records.length === 1, r.body?.records?.length);
  }
  {
    const r = await api(`/api/records/${recordId}`, opCookie, {
      method: 'PATCH',
      body: JSON.stringify({ data: { Name: 'Rahul Sharma Updated' } }),
    });
    check('Patch record (200)', r.status === 200, r.body);
    check('Patched field reflected', r.body?.record?.data?.Name === 'Rahul Sharma Updated');
  }
  {
    const r = await api('/api/contacts', opCookie);
    check('Contact auto-created from EMAIL column is visible', r.status === 200 && r.body.contacts.some((c: any) => c.primaryEmail === 'rahul-http@example.com'), r.body);
  }

  // ── Import preview + commit over HTTP (§15, never sends email) ──
  console.log('\n-- Import preview + commit --');
  let importedDatasetId: string | null = null;
  {
    const r = await api('/api/datasets/import/preview', opCookie, {
      method: 'POST',
      body: JSON.stringify({ mode: 'paste', text: 'Name\tEmail\nPriya Sharma\tpriya-http@example.com\nAmit Kumar\tamit-http@example.com' }),
    });
    check('Preview parses 2 rows', r.status === 200 && r.body.rowCount === 2, r.body);

    if (r.status === 200) {
      const commit = await api('/api/datasets/import', opCookie, {
        method: 'POST',
        body: JSON.stringify({
          datasetName: 'HTTP Smoke Imported Dataset',
          columns: [
            { key: 'Name', label: 'Name', type: 'TEXT' },
            { key: 'Email', label: 'Email', type: 'EMAIL' },
          ],
          headerToKey: { Name: 'Name', Email: 'Email' },
          rows: r.body.rows,
          emailColumn: 'Email',
          duplicateStrategy: 'KEEP_FIRST',
        }),
      });
      check('Commit import creates dataset with 2 records (201)', commit.status === 201 && commit.body.recordsImported === 2, commit.body);
      importedDatasetId = commit.body?.dataset?.id ?? null;
      if (importedDatasetId) createdDatasetIds.push(importedDatasetId);
    }
  }

  // ── Phase 2: templates, versioning, preview, health check ──
  console.log('\n-- Templates: create + version immutability --');
  let templateId: string | null = null;
  let v1Id: string | null = null;
  {
    const r = await api('/api/templates', opCookie, {
      method: 'POST',
      body: JSON.stringify({
        name: 'HTTP Smoke Template',
        subject: 'Reminder for {{Name}}',
        html: '<p>Hi {{Name}}, code {{Code}}</p>',
      }),
    });
    check('Create template (201) with an initial v1', r.status === 201 && r.body.template.versions.length === 1, r.body);
    templateId = r.body?.template?.id ?? null;
    v1Id = r.body?.template?.versions?.[0]?.id ?? null;
  }
  {
    const r = await api(`/api/templates/${templateId}/versions`, opCookie, {
      method: 'POST',
      body: JSON.stringify({ subject: 'Reminder for {{Name}} v2', html: '<p>Updated {{Name}}</p>' }),
    });
    check('Saving changes creates v2 (201)', r.status === 201 && r.body.version.version === 2, r.body);
  }
  {
    // Saving identical content must NOT inflate the version number.
    const r = await api(`/api/templates/${templateId}/versions`, opCookie, {
      method: 'POST',
      body: JSON.stringify({ subject: 'Reminder for {{Name}} v2', html: '<p>Updated {{Name}}</p>' }),
    });
    check('Re-saving unchanged content does not create a version', r.body?.created === false, r.body);
  }
  {
    // §21/§126: v1 content must be untouched by later edits.
    const r = await api(`/api/templates/${templateId}`, opCookie);
    const v1 = r.body?.template?.versions?.find((v: any) => v.id === v1Id);
    check('v1 content is immutable after v2 was saved', v1?.html === '<p>Hi {{Name}}, code {{Code}}</p>', v1?.html);
  }

  console.log('\n-- Template preview (personalization + XSS safety) --');
  {
    const r = await api(`/api/templates/${templateId}/preview`, opCookie, {
      method: 'POST',
      body: JSON.stringify({
        draft: { subject: 'Hi {{Name}}', html: '<p>Code: {{Code}}</p>' },
        data: { Name: 'Rahul Sharma', Code: 'fd41_470074' },
      }),
    });
    check('Preview substitutes variables', r.status === 200 && r.body.subject === 'Hi Rahul Sharma' && r.body.html.includes('fd41_470074'), r.body);
    check('Preview reports resolved values for the side panel', r.body?.resolved?.Name === 'Rahul Sharma');
  }
  {
    const r = await api(`/api/templates/${templateId}/preview`, opCookie, {
      method: 'POST',
      body: JSON.stringify({
        draft: { subject: 'x', html: '<p>{{Name}}</p><script>alert(1)</script>' },
        data: { Name: '<img src=x onerror=alert(1)>' },
      }),
    });
    const html: string = r.body?.html ?? '';
    check('Preview strips <script> from template HTML', !html.toLowerCase().includes('<script'), html.slice(0, 120));
    // The payload must survive only as escaped TEXT, never as a live tag:
    // "&lt;img ...&gt;" renders as visible characters and cannot fire
    // onerror; "<img ...>" would.
    check(
      'Preview escapes injected markup from record data into inert text',
      !/<img/i.test(html) && html.includes('&lt;img'),
      html.slice(0, 160)
    );
  }
  {
    const r = await api(`/api/templates/${templateId}/preview`, opCookie, {
      method: 'POST',
      body: JSON.stringify({ draft: { subject: 'Hi {{Name}}', html: '<p>{{Missing}}</p>' }, data: { Name: 'X' } }),
    });
    check('Preview reports missing variables', r.body?.missingVariables?.includes('Missing'), r.body?.missingVariables);
  }

  console.log('\n-- Email health check (§27) --');
  {
    const r = await api(`/api/templates/${templateId}/health`, opCookie, {
      method: 'POST',
      body: JSON.stringify({ draft: { subject: '', html: '<p>x</p>' } }),
    });
    check('Empty subject blocks sending', r.status === 200 && r.body.blocked === true, r.body);
  }
  {
    const r = await api(`/api/templates/${templateId}/health`, opCookie, {
      method: 'POST',
      body: JSON.stringify({ draft: { subject: 'Hi {{Nope}}', html: '<p>x</p>' }, datasetId }),
    });
    const varItem = r.body?.items?.find((i: any) => i.id === 'variables');
    check('Variable missing from dataset blocks sending', varItem?.level === 'fail', varItem);
  }
  {
    const r = await api(`/api/templates/${templateId}/health`, opCookie, {
      method: 'POST',
      body: JSON.stringify({ draft: { subject: 'Hi {{Name}}', html: '<p>{{Email}}</p>' }, datasetId }),
    });
    const varItem = r.body?.items?.find((i: any) => i.id === 'variables');
    check('Variables that exist in the dataset pass', varItem?.level === 'pass', varItem);
  }

  console.log('\n-- Template duplicate + RBAC --');
  let duplicateId: string | null = null;
  {
    const r = await api(`/api/templates/${templateId}/duplicate`, opCookie, { method: 'POST' });
    check('Duplicate creates a copy starting at v1', r.status === 201 && r.body.template.versions[0].version === 1, r.body);
    duplicateId = r.body?.template?.id ?? null;
  }
  {
    const r = await api(`/api/templates/${templateId}/versions`, viewerCookie, {
      method: 'POST',
      body: JSON.stringify({ subject: 'x', html: 'y' }),
    });
    check('VIEWER cannot save a template version (403)', r.status === 403, r.body);
  }
  {
    const r = await api(`/api/templates/${templateId}`, viewerCookie);
    check('VIEWER cannot read another workspace\'s template (403)', r.status === 403, r.body);
  }

  // ── Super Admin cross-workspace access + audit ──
  console.log('\n-- Super Admin cross-workspace access --');
  {
    const r = await api(`/api/datasets?workspaceId=${opWorkspace.id}`, adminCookie);
    check('SUPER_ADMIN can list another workspace\'s datasets', r.status === 200 && r.body.datasets.length >= 1, r.body);
  }
  {
    const r = await api('/api/admin/users', adminCookie);
    check('SUPER_ADMIN can list org users', r.status === 200 && r.body.users.length >= 3, r.body?.users?.length);
  }
  {
    const r = await api('/api/admin/users', opCookie);
    check('OPERATOR is denied /api/admin/users (403)', r.status === 403, r.body);
  }
  {
    const r = await api(`/api/admin/users/${operator.id}`, adminCookie, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'ADMIN' }),
    });
    check('SUPER_ADMIN can promote a user\'s role (200)', r.status === 200 && r.body.user.role === 'ADMIN', r.body);
  }
  {
    const auditCount = await prisma.auditLog.count({
      where: { organizationId: org.id, action: { in: ['ADMIN_VIEW', 'ROLE_CHANGE', 'DATASET_CREATE', 'DATASET_IMPORT'] } },
    });
    check('Audit log captured admin view / role change / dataset actions', auditCount >= 3, auditCount);
  }

  // ── Cleanup ──
  console.log('\n-- Cleanup --');
  for (const id of [templateId, duplicateId].filter(Boolean) as string[]) {
    await prisma.templateVersion.deleteMany({ where: { templateId: id } });
    await prisma.template.delete({ where: { id } }).catch(() => {});
  }
  for (const id of createdDatasetIds) {
    await prisma.record.deleteMany({ where: { datasetId: id } });
    await prisma.datasetColumn.deleteMany({ where: { datasetId: id } });
    await prisma.dataset.delete({ where: { id } }).catch(() => {});
  }
  await prisma.recordChangeHistory.deleteMany({ where: { record: { dataset: { workspaceId: opWorkspace.id } } } });
  await prisma.contact.deleteMany({ where: { workspaceId: { in: [opWorkspace.id] } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: org.id, actorId: { in: [operator.id, superAdmin.id, viewer.id] } } });
  await prisma.session.deleteMany({ where: { userId: { in: [operator.id, viewer.id, superAdmin.id] } } });
  await prisma.workspaceMember.deleteMany({ where: { userId: { in: [operator.id, viewer.id, superAdmin.id] } } });
  await prisma.workspace.deleteMany({ where: { ownerId: { in: [operator.id, viewer.id, superAdmin.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [operator.id, viewer.id, superAdmin.id] } } });
  console.log('  ✓ all smoke-test rows removed');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error('HTTP SMOKE TEST CRASHED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
