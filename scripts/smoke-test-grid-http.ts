/**
 * §12 grid HTTP smoke test — saved views, server-side filter/sort/group/
 * search/pagination, column reorder/hide/width, bulk update/delete.
 *
 * Runs against a live server with real NextAuth sessions for throwaway
 * fixture users (same approach as the other smoke scripts); deletes
 * everything it creates.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/smoke-test-grid-http.ts
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
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* HTML */
  }
  return { status: res.status, json };
}

const q = (obj: Record<string, unknown>) =>
  new URLSearchParams(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))).toString();

async function main() {
  console.log(`=== MailFlow grid HTTP smoke test against ${BASE_URL} ===\n`);
  const stamp = Date.now();
  const org = await prisma.organization.upsert({ where: { allowedDomain: 'masaischool.com' }, update: {}, create: { name: 'Masai School', allowedDomain: 'masaischool.com' } });
  const op = await prisma.user.create({ data: { organizationId: org.id, googleId: `grid-op-${stamp}`, email: `grid-op+${stamp}@masaischool.com`, name: 'Grid Operator', role: Role.OPERATOR } });
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: op.id, name: 'Grid WS' } });
  const viewer = await prisma.user.create({ data: { organizationId: org.id, googleId: `grid-viewer-${stamp}`, email: `grid-viewer+${stamp}@masaischool.com`, name: 'Grid Viewer', role: Role.VIEWER } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: viewer.id, role: Role.VIEWER } });
  const other = await prisma.user.create({ data: { organizationId: org.id, googleId: `grid-other-${stamp}`, email: `grid-other+${stamp}@masaischool.com`, name: 'Other', role: Role.OPERATOR } });
  const otherWs = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: other.id, name: 'Other WS' } });

  const dataset = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: ws.id, ownerId: op.id, name: `Grid Smoke ${stamp}` } });
  const cols = await Promise.all(
    [
      ['Name', 'TEXT'],
      ['Email', 'EMAIL'],
      ['Score', 'NUMBER'],
      ['Status', 'STATUS'],
    ].map(([key, type], i) => prisma.datasetColumn.create({ data: { datasetId: dataset.id, key: key!, label: key!, type: type as any, order: i } }))
  );
  const people = [
    ['Rahul', 82, 'Ready'],
    ['Anita', 91, 'Pending'],
    ['Zoya', 67, 'Ready'],
    ['Bala', 100, ''],
    ['Meera', 45, 'Pending'],
  ] as const;
  const records = [];
  for (const [name, score, status] of people) {
    records.push(await prisma.record.create({ data: { datasetId: dataset.id, data: { Name: name, Email: `${name.toLowerCase()}+${stamp}@example.com`, Score: score, Status: status } } }));
  }
  const failedRecord = records[4]!;
  await prisma.record.update({ where: { id: failedRecord.id }, data: { emailStatus: 'FAILED' } });

  // The viewer's session needs a workspace: sessions resolve workspaceId from ownership,
  // so give the viewer an (empty) workspace of their own for the 403 checks.
  await prisma.workspace.create({ data: { organizationId: org.id, ownerId: viewer.id, name: 'Viewer WS' } });

  const opCookie = await createSessionFor(op.id);
  const viewerCookie = await createSessionFor(viewer.id);
  const otherCookie = await createSessionFor(other.id);
  const base = `/api/datasets/${dataset.id}`;

  try {
    console.log('-- read: filter / search / sort / group / paginate --');
    let r = await call(base, opCookie);
    check('plain read returns everything with paging metadata', r.status === 200 && r.json.total === 5 && r.json.matched === 5 && r.json.pageCount === 1 && r.json.groups === null, r.json && { total: r.json.total, matched: r.json.matched });

    r = await call(`${base}?${q({ filter: { op: 'AND', rules: [{ field: 'Status', operator: 'equals', value: 'Ready' }] } })}`, opCookie);
    check('filter by business field', r.json?.matched === 2 && r.json.records.every((x: any) => x.data.Status === 'Ready'), r.json?.matched);

    r = await call(`${base}?${q({ filter: { op: 'AND', rules: [{ field: '__emailStatus', operator: 'equals', value: 'FAILED' }] } })}`, opCookie);
    check('filter by system email field', r.json?.matched === 1 && r.json.records[0]?.id === failedRecord.id, r.json?.matched);

    r = await call(`${base}?${q({ search: 'zoy' })}`, opCookie);
    check('search is substring + case-insensitive across columns', r.json?.matched === 1 && r.json.records[0]?.data.Name === 'Zoya', r.json?.matched);

    r = await call(`${base}?${q({ sort: [{ key: 'Score', dir: 'desc' }] })}`, opCookie);
    check('sort desc by number', r.json?.records.map((x: any) => x.data.Name).join(',') === 'Bala,Anita,Rahul,Zoya,Meera', r.json?.records.map((x: any) => x.data.Name));

    r = await call(`${base}?${q({ sort: [{ key: 'Status', dir: 'asc' }, { key: 'Name', dir: 'asc' }] })}`, opCookie);
    check('secondary sort; empty status last', r.json?.records.map((x: any) => x.data.Name).join(',') === 'Anita,Meera,Rahul,Zoya,Bala', r.json?.records.map((x: any) => x.data.Name));

    r = await call(`${base}?${q({ groupBy: 'Status', sort: [{ key: 'Name', dir: 'asc' }] })}`, opCookie);
    check('group counts over all matched + groupOf per row', JSON.stringify(r.json?.groups) === JSON.stringify([{ value: 'Pending', count: 2 }, { value: 'Ready', count: 2 }, { value: '', count: 1 }]) && r.json?.groupOf?.join(',') === 'Pending,Pending,Ready,Ready,', r.json?.groups);

    r = await call(`${base}?${q({ sort: [{ key: 'Name', dir: 'asc' }], page: '2', pageSize: '2' })}`, opCookie);
    check('pagination slices after sort', r.json?.page === 2 && r.json.pageCount === 3 && r.json.records.map((x: any) => x.data.Name).join(',') === 'Meera,Rahul', r.json?.records.map((x: any) => x.data.Name));

    r = await call(`${base}?${q({ filter: '{nope' })}`, opCookie);
    check('malformed filter is a 400, not a 500', r.status === 400, r.status);
    r = await call(`${base}?${q({ filter: { op: 'AND', rules: [{ field: 'Status', operator: 'regex', value: '.*' }] } })}`, opCookie);
    check('unknown operator is rejected (fail closed)', r.status === 400, r.status);

    console.log('-- saved views --');
    r = await call(`${base}/views`, opCookie, { method: 'POST', body: JSON.stringify({ name: 'Ready students', filter: { op: 'AND', rules: [{ field: 'Status', operator: 'equals', value: 'Ready' }] }, sort: [{ key: 'Score', dir: 'desc' }], groupBy: null }) });
    check('create view (201)', r.status === 201 && r.json?.view?.name === 'Ready students', r.json);
    const viewId = r.json?.view?.id;
    r = await call(`${base}?viewId=${viewId}`, opCookie);
    check('reading with viewId applies its filter + sort', r.json?.viewId === viewId && r.json.matched === 2 && r.json.records.map((x: any) => x.data.Name).join(',') === 'Rahul,Zoya', r.json?.records?.map((x: any) => x.data.Name));
    r = await call(`${base}?${q({ viewId, sort: [{ key: 'Score', dir: 'asc' }] })}`, opCookie);
    check('explicit sort overrides the view sort, filter still applies', r.json?.matched === 2 && r.json.records.map((x: any) => x.data.Name).join(',') === 'Zoya,Rahul', r.json?.records?.map((x: any) => x.data.Name));
    r = await call(`${base}/views/${viewId}`, opCookie, { method: 'PATCH', body: JSON.stringify({ name: 'Ready (renamed)', groupBy: 'Status' }) });
    check('update view (name + groupBy)', r.status === 200 && r.json?.view?.name === 'Ready (renamed)' && r.json.view.groupBy === 'Status', r.json);
    r = await call(`${base}/views`, opCookie);
    check('views listed on the dataset', r.json?.views?.length === 1, r.json);
    r = await call(base, opCookie);
    check('views are included in the grid read', r.json?.savedViews?.length === 1, r.json?.savedViews);
    r = await call(`${base}/views`, viewerCookie, { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    check('viewer cannot create views (403)', r.status === 403, r.status);
    r = await call(`${base}/views`, otherCookie);
    check("another workspace cannot list this dataset's views (403)", r.status === 403, r.status);
    r = await call(`${base}/views/${viewId}`, opCookie, { method: 'DELETE' });
    check('delete view', r.status === 200, r.json);
    const auditViews = await prisma.auditLog.count({ where: { actorId: op.id, action: { in: ['SAVED_VIEW_CREATE', 'SAVED_VIEW_UPDATE', 'SAVED_VIEW_DELETE'] } } });
    check('view create/update/delete audited', auditViews === 3, auditViews);

    console.log('-- columns --');
    const reversed = [...cols].reverse().map((c) => c.id);
    r = await call(`${base}/columns`, opCookie, { method: 'PATCH', body: JSON.stringify({ order: reversed }) });
    check('reorder columns', r.status === 200 && r.json?.columns?.map((c: any) => c.key).join(',') === 'Status,Score,Email,Name', r.json?.columns?.map((c: any) => c.key));
    r = await call(`${base}/columns`, opCookie, { method: 'PATCH', body: JSON.stringify({ order: [...reversed, 'not-a-column'] }) });
    check('reorder rejects foreign ids (400)', r.status === 400, r.status);
    r = await call(`${base}/columns/${cols[1]!.id}`, opCookie, { method: 'PATCH', body: JSON.stringify({ hidden: true, width: 240 }) });
    check('hide + resize column', r.status === 200, r.json);
    const col = await prisma.datasetColumn.findUnique({ where: { id: cols[1]!.id } });
    check('…persisted', col?.hidden === true && col?.width === 240, col);
    r = await call(`${base}/columns`, viewerCookie, { method: 'PATCH', body: JSON.stringify({ order: reversed }) });
    check('viewer cannot reorder (403)', r.status === 403, r.status);

    console.log('-- bulk --');
    const ids = records.slice(0, 3).map((x) => x.id);
    r = await call(`${base}/records/bulk`, opCookie, { method: 'POST', body: JSON.stringify({ action: 'update', recordIds: [...ids, 'ghost-id'], data: { Status: 'Contacted' } }) });
    check('bulk update reports updated/ignored', r.status === 200 && r.json?.updated === 3 && r.json.ignored === 1, r.json);
    const after = await prisma.record.findMany({ where: { id: { in: ids } } });
    check('…values written', after.every((x) => (x.data as any).Status === 'Contacted'), after.map((x) => (x.data as any).Status));
    const hist = await prisma.recordChangeHistory.count({ where: { recordId: { in: ids }, field: 'Status', reason: 'Bulk edit' } });
    check('…change history per record', hist === 3, hist);
    r = await call(`${base}/records/bulk`, opCookie, { method: 'POST', body: JSON.stringify({ action: 'update', recordIds: ids, data: { Status: 'Contacted' } }) });
    check('repeating the same edit is a no-op', r.json?.updated === 0 && r.json?.unchanged === 3, r.json);
    // Bulk must not reach into another dataset by id.
    const foreignDs = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: otherWs.id, ownerId: other.id, name: 'Foreign' } });
    const foreignRec = await prisma.record.create({ data: { datasetId: foreignDs.id, data: { Name: 'Foreign' } } });
    r = await call(`${base}/records/bulk`, opCookie, { method: 'POST', body: JSON.stringify({ action: 'update', recordIds: [foreignRec.id], data: { Name: 'Hacked' } }) });
    const foreignAfter = await prisma.record.findUnique({ where: { id: foreignRec.id } });
    check("ids from another dataset are ignored, never written", r.json?.updated === 0 && r.json?.ignored === 1 && (foreignAfter?.data as any).Name === 'Foreign', r.json);
    r = await call(`${base}/records/bulk`, viewerCookie, { method: 'POST', body: JSON.stringify({ action: 'delete', recordIds: ids }) });
    check('viewer cannot bulk delete (403)', r.status === 403, r.status);
    r = await call(`${base}/records/bulk`, opCookie, { method: 'POST', body: JSON.stringify({ action: 'update', recordIds: ids, data: {} }) });
    check('empty data is rejected (400)', r.status === 400, r.status);
    r = await call(`${base}/records/bulk`, opCookie, { method: 'POST', body: JSON.stringify({ action: 'delete', recordIds: ids.slice(0, 2) }) });
    check('bulk delete', r.status === 200 && r.json?.deleted === 2, r.json);
    const remaining = await prisma.record.count({ where: { datasetId: dataset.id } });
    check('…rows gone', remaining === 3, remaining);
    const auditBulk = await prisma.auditLog.findMany({ where: { actorId: op.id, action: { in: ['RECORD_BULK_UPDATE', 'RECORD_BULK_DELETE'] } } });
    check('bulk actions audited with counts', auditBulk.some((a) => a.action === 'RECORD_BULK_DELETE' && (a.metadata as any).deleted === 2) && auditBulk.some((a) => a.action === 'RECORD_BULK_UPDATE' && (a.metadata as any).updated === 3), auditBulk.map((a) => a.metadata));

    await prisma.record.deleteMany({ where: { datasetId: foreignDs.id } });
    await prisma.dataset.delete({ where: { id: foreignDs.id } });

    console.log('-- page --');
    const page = await fetch(`${BASE_URL}/data/${dataset.id}`, { headers: { Cookie: opCookie }, redirect: 'manual' });
    check('dataset page renders (200)', page.status === 200, page.status);
  } finally {
    console.log('\n-- cleanup --');
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [op.id, viewer.id, other.id] } } });
    await prisma.session.deleteMany({ where: { userId: { in: [op.id, viewer.id, other.id] } } });
    await prisma.dataset.deleteMany({ where: { id: dataset.id } });
    await prisma.contact.deleteMany({ where: { workspaceId: { in: [ws.id, otherWs.id] } } });
    await prisma.workspaceMember.deleteMany({ where: { userId: { in: [op.id, viewer.id, other.id] } } });
    await prisma.workspace.deleteMany({ where: { ownerId: { in: [op.id, viewer.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [op.id, viewer.id, other.id] } } });
    await prisma.$disconnect();
  }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
