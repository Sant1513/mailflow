import { Prisma, type Record as DataRecord } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { applyView, SYSTEM_FIELD_KEYS, type QueryableRecord, type ViewQuery, type ViewResult } from '@/lib/records/query';
import type { ConditionGroup } from '@/lib/automation/conditions';

/**
 * The data grid's read, without loading whole datasets into memory (and through the database's
 * monthly data allowance) on every page view:
 *   - plain browsing (no filter / sort / search / grouping): the database pages directly;
 *   - filter / sort / grouping: only the columns those use are read for every row, the exact
 *     rules of lib/records/query.ts (shared with automations) pick and order the rows, then
 *     only the requested page is loaded in full;
 *   - search: the database narrows to rows containing the text, then the exact search runs
 *     on those.
 */
export const GRID_ROW_LIMIT = 100_000;

const SYSTEM = new Set<string>(SYSTEM_FIELD_KEYS);

/** Data keys a query reads (system `__` fields are always available). */
export function referencedKeys(query: ViewQuery): string[] {
  const keys = new Set<string>();
  const walk = (g: ConditionGroup | undefined) => {
    for (const r of g?.rules ?? []) {
      if ('rules' in r) walk(r as ConditionGroup);
      else if ('field' in r && !SYSTEM.has(r.field)) keys.add(r.field);
    }
  };
  walk(query.filter);
  for (const s of query.sort ?? []) if (!SYSTEM.has(s.key)) keys.add(s.key);
  if (query.groupBy && !SYSTEM.has(query.groupBy)) keys.add(query.groupBy);
  return [...keys];
}

export function needsRuleEngine(query: ViewQuery): boolean {
  return !!(query.filter?.rules?.length || query.search?.trim() || query.groupBy?.trim() || query.sort?.length);
}

type LightRow = QueryableRecord & { id: string };

const SYSTEM_COLUMNS = Prisma.sql`"id", "createdAt", "emailStatus", "replyReceived", "unreadReply", "followUpRequired", "lastEmailSentAt", "lastReplyAt"`;

async function lightRows(datasetId: string, keys: string[]): Promise<LightRow[]> {
  const data = keys.length
    ? Prisma.sql`jsonb_build_object(${Prisma.join(keys.map((k) => Prisma.sql`${k}::text, "data"->${k}`))})`
    : Prisma.sql`'{}'::jsonb`;
  return prisma.$queryRaw<LightRow[]>`
    SELECT ${SYSTEM_COLUMNS}, ${data} AS "data"
    FROM "Record" WHERE "datasetId" = ${datasetId}
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${GRID_ROW_LIMIT}`;
}

async function searchCandidates(datasetId: string, search: string): Promise<LightRow[]> {
  const like = `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return prisma.$queryRaw<LightRow[]>`
    SELECT ${SYSTEM_COLUMNS}, "data"
    FROM "Record"
    WHERE "datasetId" = ${datasetId} AND ("data"::text ILIKE ${like} OR "emailStatus" ILIKE ${like})
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${GRID_ROW_LIMIT}`;
}

export async function queryGrid(
  datasetId: string,
  query: ViewQuery,
): Promise<Omit<ViewResult<LightRow>, 'records'> & { records: DataRecord[]; total: number; truncated: boolean }> {
  const total = await prisma.record.count({ where: { datasetId } });

  if (!needsRuleEngine(query)) {
    const pageSize = query.pageSize;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(query.page, pageCount);
    const records = await prisma.record.findMany({
      where: { datasetId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { records, matched: total, page, pageSize, pageCount, groups: null, groupOf: null, total, truncated: false };
  }

  const rows = query.search?.trim() ? await searchCandidates(datasetId, query.search) : await lightRows(datasetId, referencedKeys(query));
  const result = applyView(rows, query);

  // Load the page in full, in the order the rules decided.
  const ids = result.records.map((r) => r.id);
  const full = ids.length ? await prisma.record.findMany({ where: { id: { in: ids } } }) : [];
  const byId = new Map(full.map((r) => [r.id, r]));
  const records = ids.map((id) => byId.get(id)).filter((r): r is DataRecord => !!r);

  return { ...result, records, total, truncated: total > GRID_ROW_LIMIT };
}
