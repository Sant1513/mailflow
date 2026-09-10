import { z } from 'zod';
import { evaluateCondition, type ConditionGroup } from '@/lib/automation/conditions';

/**
 * §12 grid query: filter / search / sort / group / paginate, as pure
 * functions over already-loaded records. Filters reuse the automation
 * condition engine so "Status = Ready" means the same thing in a saved view
 * as in an automation. Everything runs server-side; the browser only ever
 * receives one page (§135).
 *
 * System email fields (§14) are exposed to filters and sorts under
 * `__`-prefixed keys so a view like "Email Status = FAILED" is possible
 * without those values ever living inside a record's business data.
 */

export const SYSTEM_FIELD_KEYS = [
  '__emailStatus',
  '__replyReceived',
  '__unreadReply',
  '__followUpRequired',
  '__lastEmailSentAt',
  '__lastReplyAt',
  '__createdAt',
] as const;

export const SYSTEM_FIELD_LABELS: Record<(typeof SYSTEM_FIELD_KEYS)[number], string> = {
  __emailStatus: 'Email Status',
  __replyReceived: 'Reply Received',
  __unreadReply: 'Unread Reply',
  __followUpRequired: 'Follow-up Required',
  __lastEmailSentAt: 'Last Email Sent At',
  __lastReplyAt: 'Last Reply At',
  __createdAt: 'Created At',
};

export interface QueryableRecord {
  id: string;
  data: Record<string, unknown>;
  emailStatus?: string | null;
  replyReceived?: boolean;
  unreadReply?: boolean;
  followUpRequired?: boolean;
  lastEmailSentAt?: Date | string | null;
  lastReplyAt?: Date | string | null;
  createdAt?: Date | string;
}

const ruleSchema = z.object({
  field: z.string().min(1).max(100),
  operator: z.enum(['equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than', 'is_empty', 'is_not_empty']),
  value: z.unknown().optional(),
});

export const filterSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.object({
    op: z.enum(['AND', 'OR']),
    rules: z.array(z.union([ruleSchema, filterSchema])).max(50),
  })
) as z.ZodType<ConditionGroup>;

export const sortSchema = z
  .array(z.object({ key: z.string().min(1).max(100), dir: z.enum(['asc', 'desc']).default('asc') }))
  .max(3);

export type SortSpec = z.infer<typeof sortSchema>;

export const viewQuerySchema = z.object({
  filter: filterSchema.optional(),
  sort: sortSchema.optional(),
  search: z.string().max(200).optional(),
  groupBy: z.string().max(100).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(100),
});

export type ViewQuery = z.infer<typeof viewQuerySchema>;

/** Business data plus the `__` system fields, as one flat object for the evaluator. */
export function flatten(record: QueryableRecord): Record<string, unknown> {
  return {
    ...record.data,
    __emailStatus: record.emailStatus ?? 'NOT_SENT',
    __replyReceived: record.replyReceived ?? false,
    __unreadReply: record.unreadReply ?? false,
    __followUpRequired: record.followUpRequired ?? false,
    __lastEmailSentAt: toIso(record.lastEmailSentAt),
    __lastReplyAt: toIso(record.lastReplyAt),
    __createdAt: toIso(record.createdAt),
  };
}

function toIso(v: Date | string | null | undefined): string {
  if (!v) return '';
  return v instanceof Date ? v.toISOString() : String(v);
}

export function matchesSearch(flat: Record<string, unknown>, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return Object.values(flat).some((v) => v != null && String(v).toLowerCase().includes(needle));
}

/** Numbers before strings, numeric compare when both parse, else locale compare; empty last. */
export function compareValues(a: unknown, b: unknown): number {
  const ea = a == null || a === '';
  const eb = b == null || b === '';
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  const na = typeof a === 'number' ? a : Number(a);
  const nb = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function sortRecords<T extends QueryableRecord>(records: T[], sort: SortSpec | undefined): T[] {
  if (!sort || sort.length === 0) return records;
  const flats = new Map(records.map((r) => [r.id, flatten(r)]));
  const isEmpty = (v: unknown) => v == null || v === '';
  return [...records].sort((x, y) => {
    for (const s of sort) {
      const a = flats.get(x.id)?.[s.key];
      const b = flats.get(y.id)?.[s.key];
      // Empty cells sort last in BOTH directions — flipping them to the top
      // on a descending sort is never what a spreadsheet user wants.
      if (isEmpty(a) !== isEmpty(b)) return isEmpty(a) ? 1 : -1;
      const c = compareValues(a, b);
      if (c !== 0) return s.dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

export interface GroupSummary {
  /** Display value of the group key ('' for empty). */
  value: string;
  count: number;
}

export interface ViewResult<T extends QueryableRecord> {
  /** Records on the requested page, in final order. */
  records: T[];
  /** Records matching filter + search, before pagination. */
  matched: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Present when groupBy is set: counts across ALL matched records, in display order. */
  groups: GroupSummary[] | null;
  /** For each record on the page, its group value (same order as `records`). */
  groupOf: string[] | null;
}

/**
 * The whole pipeline. When grouping, records are ordered by group first
 * (groups sorted by their value, empty last) and by `sort` inside a group,
 * so a page always shows whole runs of the same group.
 */
export function applyView<T extends QueryableRecord>(records: T[], query: ViewQuery): ViewResult<T> {
  const filter = query.filter;
  const search = query.search ?? '';

  let matched = records.filter((r) => {
    const flat = flatten(r);
    if (filter && !evaluateCondition(filter, flat)) return false;
    return matchesSearch(flat, search);
  });

  const groupBy = query.groupBy?.trim() || null;
  let groups: GroupSummary[] | null = null;

  if (groupBy) {
    const groupValue = (r: T) => {
      const v = flatten(r)[groupBy];
      return v == null ? '' : String(v);
    };
    const counts = new Map<string, number>();
    for (const r of matched) counts.set(groupValue(r), (counts.get(groupValue(r)) ?? 0) + 1);
    groups = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => compareValues(a.value === '' ? null : a.value, b.value === '' ? null : b.value));
    const rank = new Map(groups.map((g, i) => [g.value, i]));
    const inner = sortRecords(matched, query.sort);
    matched = [...inner].sort((a, b) => (rank.get(groupValue(a)) ?? 0) - (rank.get(groupValue(b)) ?? 0));
  } else {
    matched = sortRecords(matched, query.sort);
  }

  const pageSize = query.pageSize;
  const pageCount = Math.max(1, Math.ceil(matched.length / pageSize));
  const page = Math.min(query.page, pageCount);
  const slice = matched.slice((page - 1) * pageSize, page * pageSize);

  return {
    records: slice,
    matched: matched.length,
    page,
    pageSize,
    pageCount,
    groups,
    groupOf: groupBy
      ? slice.map((r) => {
          const v = flatten(r)[groupBy];
          return v == null ? '' : String(v);
        })
      : null,
  };
}

/** Parses the grid's query-string form: JSON for filter/sort, plain strings otherwise. */
export function parseViewQuery(params: URLSearchParams): ViewQuery {
  const json = (key: string) => {
    const raw = params.get(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new z.ZodError([{ code: 'custom', path: [key], message: `${key} must be JSON` }]);
    }
  };
  return viewQuerySchema.parse({
    filter: json('filter'),
    sort: json('sort'),
    search: params.get('search') ?? undefined,
    groupBy: params.get('groupBy') ?? undefined,
    page: params.get('page') ? Number(params.get('page')) : undefined,
    pageSize: params.get('pageSize') ? Number(params.get('pageSize')) : undefined,
  });
}

/** Body of POST/PATCH /api/datasets/[id]/views — a named filter + sort + groupBy. */
export const viewBodySchema = z.object({
  name: z.string().min(1).max(100),
  filter: filterSchema.default({ op: 'AND', rules: [] }),
  sort: sortSchema.nullable().optional(),
  groupBy: z.string().max(100).nullable().optional(),
});
