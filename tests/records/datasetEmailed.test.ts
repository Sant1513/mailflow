import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Data page API: "Last emailed" per row and the "recently emailed" filter for a dataset with an EMAIL column. The filter is handed to
 * queryGrid as a SQL condition on mailflow_email_key(data->>'<email column>'); a dataset without an email column gets neither.
 */
const dataset = { id: 'd1', organizationId: 'org1', workspaceId: 'w1', name: 'D' };
const db = {
  savedView: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  datasetColumn: { findMany: vi.fn(async (_q: any): Promise<any[]> => []) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const session = { userId: 'u1', organizationId: 'org1', workspaceId: 'w1', role: 'OPERATOR' as string, viewingAs: null as any };
vi.mock('@/lib/auth/session', async (orig) => ({ ...(await orig<any>()), requireSession: vi.fn(async () => session) }));
vi.mock('@/lib/records/datasetAccess', () => ({ loadDatasetForSession: vi.fn(async () => dataset) }));
const queryGrid = vi.fn(async (_id: string, _q: any, _extra?: any): Promise<any> => ({}));
vi.mock('@/lib/records/gridQuery', () => ({ queryGrid }));
const recent = {
  lastEmailed: vi.fn(async (_org: string, _emails: string[]) => new Map<string, any>()),
  recentlyEmailedKeys: vi.fn(async (_org: string, _days: number) => new Map<string, any>()),
};
vi.mock('@/lib/recruiterSend/recent', () => recent);

const { GET } = await import('@/app/api/datasets/[id]/route');
const get = (qs = '') => GET(new Request(`http://localhost/api/datasets/d1?${qs}`), { params: { id: 'd1' } });
const result = (records: any[]) => ({ records, total: 100000, matched: records.length, page: 1, pageSize: 100, pageCount: 1, groups: null, groupOf: null, truncated: false });

beforeEach(() => {
  vi.clearAllMocks();
  recent.lastEmailed.mockImplementation(async () => new Map());
  recent.recentlyEmailedKeys.mockImplementation(async () => new Map());
});

describe('GET /api/datasets/[id] emailed', () => {
  it('adds Last emailed per record of the page only, by email key', async () => {
    db.datasetColumn.findMany.mockResolvedValueOnce([{ key: 'name', type: 'TEXT' }, { key: 'mail', type: 'EMAIL' }]);
    queryGrid.mockResolvedValueOnce(result([{ id: 'r1', data: { mail: 'J.Doe@gmail.com' } }, { id: 'r2', data: { mail: '' } }, { id: 'r3', data: { mail: 'z@z.com' } }]));
    recent.lastEmailed.mockResolvedValueOnce(new Map([['jdoe@gmail.com', { at: new Date('2026-11-10T00:00:00Z'), subject: 'S', source: 'Campaign “C”', from: null, kind: 'campaign', pending: false, count: 2 }]]));
    const json = await (await get()).json();
    expect(json.emailColumnKey).toBe('mail');
    expect(json.lastEmailed.r1).toEqual({ at: '2026-11-10T00:00:00.000Z', subject: 'S', source: 'Campaign “C”', from: null });
    expect(json.lastEmailed.r2).toBeNull();
    expect(json.lastEmailed.r3).toBeNull();
    expect(recent.lastEmailed).toHaveBeenCalledWith('org1', ['J.Doe@gmail.com', 'z@z.com']);
    expect(recent.recentlyEmailedKeys).not.toHaveBeenCalled();
    expect(queryGrid.mock.calls[0]![2]).toBeNull();
  });

  it('passes the recently-emailed filter to the database as a condition on the email column', async () => {
    db.datasetColumn.findMany.mockResolvedValueOnce([{ key: 'mail', type: 'EMAIL' }]);
    recent.recentlyEmailedKeys.mockResolvedValueOnce(new Map([['a@b.com', {}]]));
    queryGrid.mockResolvedValueOnce(result([]));
    await get('emailed=not&emailedDays=30&page=3');
    expect(recent.recentlyEmailedKeys).toHaveBeenCalledWith('org1', 30);
    const extra = queryGrid.mock.calls[0]![2];
    expect(extra.sql).toContain('mailflow_email_key(("data"->>?::text))');
    expect(extra.values).toEqual(['mail', ['a@b.com']]);
    expect(queryGrid.mock.calls[0]![1].page).toBe(3);
  });

  it('a dataset without an email column shows neither and ignores the filter', async () => {
    db.datasetColumn.findMany.mockResolvedValueOnce([{ key: 'name', type: 'TEXT' }]);
    queryGrid.mockResolvedValueOnce(result([{ id: 'r1', data: { name: 'x' } }]));
    const json = await (await get('emailed=within')).json();
    expect(json.emailColumnKey).toBeNull();
    expect(json.lastEmailed).toBeNull();
    expect(recent.recentlyEmailedKeys).not.toHaveBeenCalled();
    expect(recent.lastEmailed).not.toHaveBeenCalled();
    expect(queryGrid.mock.calls[0]![2]).toBeNull();
  });
});
