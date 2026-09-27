import { describe, expect, it } from 'vitest';
import {
  columnLetter,
  mapHeaders,
  planSync,
  quoteSheet,
  spreadsheetIdFromUrl,
  type PlanRecord,
  type SyncPlanInput,
} from '@/lib/sheets/plan';

const connectedAt = new Date('2026-09-20T00:00:00Z');
const owned = [
  { key: 'signing_status', label: 'Signing status' },
  { key: 'signed_at', label: 'Signed at' },
];
const columns = [
  { key: 'email', label: 'Email', type: 'EMAIL' },
  { key: 'name', label: 'Name', type: 'TEXT' },
  { key: 'ctc', label: 'CTC', type: 'NUMBER' },
];
const rec = (id: string, data: Record<string, unknown>, createdAt = new Date('2026-09-01T00:00:00Z')): PlanRecord => ({ id, data, createdAt });

function input(over: Partial<SyncPlanInput>): SyncPlanInput {
  return {
    values: [['Email', 'Name', 'CTC']],
    columns,
    records: [],
    keyHeader: 'Email',
    owned,
    editedSince: new Map(),
    connectedAt,
    ...over,
  };
}

describe('sheet helpers', () => {
  it('column letters', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(701)).toBe('ZZ');
    expect(columnLetter(702)).toBe('AAA');
  });

  it('quotes sheet names for A1 ranges', () => {
    expect(quoteSheet('KPI Placement Ops')).toBe("'KPI Placement Ops'");
    expect(quoteSheet("Rahul's tab")).toBe("'Rahul''s tab'");
  });

  it('reads spreadsheet ids from links or raw ids', () => {
    const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
    expect(spreadsheetIdFromUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
    expect(spreadsheetIdFromUrl(id)).toBe(id);
    expect(spreadsheetIdFromUrl('https://example.com/spreadsheets/d/' + id)).toBeNull();
    expect(spreadsheetIdFromUrl('nope')).toBeNull();
  });

  it('maps headers to existing columns and creates the rest, without clashing keys', () => {
    const { keys, newColumns } = mapHeaders(['Email', 'Company', '', 'name', 'Company', '2026 Offer'], columns);
    expect(keys).toEqual(['email', 'company', null, 'name', 'company_2', 'column_6']);
    expect(newColumns.map((c) => c.key)).toEqual(['company', 'company_2', 'column_6']);
  });
});

describe('planSync', () => {
  it('fails clearly without a header row or key column', () => {
    expect(planSync(input({ values: [] })).error).toMatch(/header row/);
    expect(planSync(input({ keyHeader: 'Phone' })).error).toMatch(/"Phone"/);
  });

  it('imports new sheet rows as records, typing numbers', () => {
    const plan = planSync(input({ values: [['Email', 'Name', 'CTC'], ['A@x.com', 'Asha', '6,00,000'], ['', 'no key', ''], ['a@x.com', 'dup', '']] }));
    expect(plan.recordCreates).toEqual([{ data: { email: 'A@x.com', name: 'Asha', ctc: 600000 } }]);
    expect(plan.skippedNoKey).toBe(1);
    expect(plan.duplicateKeys).toBe(1);
  });

  it('sheet wins for cells not edited in MailFlow', () => {
    const plan = planSync(input({
      values: [['Email', 'Name', 'CTC'], ['a@x.com', 'Asha K', '700000']],
      records: [rec('r1', { email: 'a@x.com', name: 'Asha', ctc: 600000 })],
    }));
    expect(plan.recordUpdates).toEqual([{ recordId: 'r1', fields: { name: 'Asha K', ctc: 700000 } }]);
    expect(plan.cellWrites).toEqual([]);
  });

  it('a cell edited in MailFlow since the last sync is written to the sheet instead', () => {
    const plan = planSync(input({
      values: [['Email', 'Name', 'CTC'], ['a@x.com', 'Asha K', '700000']],
      records: [rec('r1', { email: 'a@x.com', name: 'Asha', ctc: 600000 })],
      editedSince: new Map([['r1', new Set(['name'])]]),
    }));
    expect(plan.recordUpdates).toEqual([{ recordId: 'r1', fields: { ctc: 700000 } }]);
    expect(plan.cellWrites).toEqual([{ row: 1, col: 1, value: 'Asha' }]);
  });

  it('matching values do nothing', () => {
    const plan = planSync(input({
      values: [['Email', 'Name', 'CTC'], ['A@X.com', 'Asha', '600000']],
      records: [rec('r1', { email: 'a@x.com', name: 'Asha', ctc: 600000 })],
    }));
    expect(plan.recordUpdates).toEqual([{ recordId: 'r1', fields: { email: 'A@X.com' } }]);
    expect(plan.cellWrites).toEqual([]);
    expect(plan.appendRows).toEqual([]);
  });

  it('adds headers for MailFlow-owned columns only once a row has a value, and pushes them', () => {
    const plan = planSync(input({
      values: [['Email', 'Name', 'CTC'], ['a@x.com', 'Asha', '600000'], ['b@x.com', 'Bo', '']],
      records: [rec('r1', { email: 'a@x.com', name: 'Asha', ctc: 600000, signing_status: 'Signed' }), rec('r2', { email: 'b@x.com', name: 'Bo' })],
    }));
    expect(plan.cellWrites).toEqual([
      { row: 0, col: 3, value: 'Signing status' },
      { row: 1, col: 3, value: 'Signed' },
    ]);
  });

  it('owned columns always flow MailFlow → sheet, even if the sheet was edited', () => {
    const plan = planSync(input({
      values: [['Email', 'Signing status'], ['a@x.com', 'typed by hand']],
      records: [rec('r1', { email: 'a@x.com', signing_status: 'Sent' })],
    }));
    expect(plan.recordUpdates).toEqual([]);
    expect(plan.cellWrites).toEqual([{ row: 1, col: 1, value: 'Sent' }]);
  });

  it('appends rows created in MailFlow after connecting, not older ones', () => {
    const plan = planSync(input({
      values: [['Email', 'Name', 'CTC']],
      records: [
        rec('old', { email: 'old@x.com', name: 'Old' }),
        rec('new', { email: 'new@x.com', name: 'New', ctc: 5 }, new Date('2026-09-25T00:00:00Z')),
      ],
    }));
    expect(plan.appendRows).toEqual([['new@x.com', 'New', '5']]);
  });

  it('uses the display formatter for values written to the sheet', () => {
    const plan = planSync(input({
      values: [['Email', 'Signed at'], ['a@x.com', '']],
      records: [rec('r1', { email: 'a@x.com', signed_at: '2026-09-27T08:35:00.000Z' })],
      display: (v, key) => (key === 'signed_at' ? 'formatted' : String(v ?? '')),
    }));
    expect(plan.cellWrites).toEqual([{ row: 1, col: 1, value: 'formatted' }]);
  });
});
