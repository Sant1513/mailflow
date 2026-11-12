import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csvCell, csvFileName, parseOpenFilter, toCsv } from '@/lib/export/csv';

/**
 * Opened / not-opened downloads: the CSV is safe to open in Excel, and the recruiter export
 * picks the right people, keeps the uploaded columns (UTM ids) and refuses per-person opens
 * for BCC sends, where one email reaches many recruiters.
 */

describe('csv helper', () => {
  it('quotes every cell, doubles quotes and stops formulas', () => {
    expect(csvCell('a "b" c')).toBe('"a ""b"" c"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+91 99')).toBe(`"'+91 99"`);
    expect(csvCell(null)).toBe('""');
    expect(csvCell(3)).toBe('"3"');
  });
  it('starts with a BOM and uses CRLF rows', () => {
    const out = toCsv(['A', 'B'], [['1', '2']]);
    expect(out.startsWith('﻿"A","B"\r\n"1","2"')).toBe(true);
  });
  it('writes dates in IST', () => {
    expect(csvCell(new Date('2026-11-11T12:56:50Z'))).toContain('06:26');
  });
  it('makes safe file names and reads the filter', () => {
    expect(csvFileName('Dec Drive Invite / First: Email', 'opened')).toBe('Dec Drive Invite First Email - opened.csv');
    expect(parseOpenFilter('opened')).toBe('opened');
    expect(parseOpenFilter('nonsense')).toBe('all');
  });
});

const db = {
  recruiterBlastRecipient: { findMany: vi.fn() },
  recruiterBlastGroup: { findMany: vi.fn() },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/audit/log', () => ({ audit: vi.fn(async () => undefined) }));
const blast = { id: 'b1', name: 'Dec Drive Invite', mode: 'INDIVIDUAL', columns: ['Email Id', 'Link'], emailColumn: 'Email Id' };
const access = { requireBlastReader: vi.fn(async () => ({ organizationId: 'o1', workspaceId: 'w1' })), loadBlast: vi.fn(async () => blast as any) };
vi.mock('@/lib/recruiterSend/access', () => access);

const { GET } = await import('@/app/api/recruiter-blasts/[id]/export/route');
const call = (filter: string) => GET(new Request(`http://x/api/recruiter-blasts/b1/export?filter=${filter}`), { params: { id: 'b1' } });

beforeEach(() => {
  vi.clearAllMocks();
  db.recruiterBlastGroup.findMany.mockResolvedValue([{ id: 'g1', fromEmail: 'placements@masaischool.com', openCount: 2, error: null }]);
  db.recruiterBlastRecipient.findMany.mockResolvedValue([
    { email: 'hr@acme.com', name: 'Asha', status: 'SENT', skipReason: null, groupId: 'g1', sentAt: new Date('2026-11-11T12:56:50Z'), openedAt: new Date('2026-11-11T13:10:00Z'), openCount: 2, repliedAt: null, data: { 'Email Id': 'hr@acme.com', Link: 'https://x/?utm_medium=1111_2a' } },
  ]);
});

describe('recruiter send export', () => {
  it('asks the database only for openers when filter=opened', async () => {
    await call('opened');
    expect((db.recruiterBlastRecipient.findMany.mock.calls[0] as any[])[0].where).toEqual({ blastId: 'b1', openedAt: { not: null } });
  });
  it('not opened = sent and no open yet', async () => {
    await call('not_opened');
    expect((db.recruiterBlastRecipient.findMany.mock.calls[0] as any[])[0].where).toEqual({ blastId: 'b1', status: 'SENT', openedAt: null });
  });
  it('downloads a CSV with opened, the sending mailbox and the list’s own columns', async () => {
    const res = await call('all');
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('Dec Drive Invite - recruiters all.csv');
    const text = await res.text();
    const [head, row] = text.replace('﻿', '').split('\r\n');
    expect(head).toContain('"Opened"');
    expect(head).toContain('"Link"');
    expect(head).not.toContain('"Email Id"');
    expect(row).toContain('"hr@acme.com"');
    expect(row).toContain('"Yes"');
    expect(row).toContain('"placements@masaischool.com"');
    expect(row).toContain('utm_medium=1111_2a');
  });
  it('refuses opened / not-opened for BCC sends but still exports everyone', async () => {
    access.loadBlast.mockResolvedValueOnce({ ...blast, mode: 'BCC' } as any);
    expect((await call('opened')).status).toBe(400);
    access.loadBlast.mockResolvedValueOnce({ ...blast, mode: 'BCC' } as any);
    const res = await call('all');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Opened (BCC: not tracked per person)');
  });
});
