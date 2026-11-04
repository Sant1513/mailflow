import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ColumnType } from '@prisma/client';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    datasetColumn: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
    contact: { upsert: vi.fn() },
  },
}));

const { prisma } = await import('@/lib/db/client');
const { findOrCreateContactForRecord } = await import('@/lib/records/contactLink');

describe('findOrCreateContactForRecord', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when the dataset has no EMAIL column', async () => {
    (prisma.datasetColumn.findFirst as any).mockResolvedValue(null);
    const result = await findOrCreateContactForRecord({
      organizationId: 'org1',
      workspaceId: 'ws1',
      datasetId: 'ds1',
      data: { Email: 'a@example.com' },
    });
    expect(result).toBeNull();
    expect(prisma.contact.upsert).not.toHaveBeenCalled();
  });

  it('returns null when the email value is missing or malformed', async () => {
    (prisma.datasetColumn.findFirst as any).mockResolvedValue({ key: 'Email', type: ColumnType.EMAIL });
    const result = await findOrCreateContactForRecord({
      organizationId: 'org1',
      workspaceId: 'ws1',
      datasetId: 'ds1',
      data: { Email: 'not-an-email' },
    });
    expect(result).toBeNull();
    expect(prisma.contact.upsert).not.toHaveBeenCalled();
  });

  it('upserts a Contact keyed by (workspaceId, lowercased email) when valid', async () => {
    (prisma.datasetColumn.findFirst as any)
      .mockResolvedValueOnce({ key: 'Email', type: ColumnType.EMAIL }); // email column lookup
    (prisma.contact.upsert as any).mockResolvedValue({ id: 'contact-1' });

    const result = await findOrCreateContactForRecord({
      organizationId: 'org1',
      workspaceId: 'ws1',
      datasetId: 'ds1',
      data: { Email: 'Rahul@Example.com' },
    });

    expect(result).toBe('contact-1');
    expect(prisma.contact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_primaryEmail: { workspaceId: 'ws1', primaryEmail: 'rahul@example.com' } },
      })
    );
  });

  it('takes the person name from the Name column, not Username', async () => {
    (prisma.datasetColumn.findFirst as any).mockResolvedValueOnce({ key: 'Email', type: ColumnType.EMAIL });
    (prisma.datasetColumn.findMany as any).mockResolvedValueOnce([
      { key: 'Username', label: 'Username', type: ColumnType.TEXT },
      { key: 'name', label: 'name', type: ColumnType.TEXT },
    ]);
    (prisma.contact.upsert as any).mockResolvedValue({ id: 'contact-2' });
    await findOrCreateContactForRecord({ organizationId: 'org1', workspaceId: 'ws1', datasetId: 'ds1', data: { Email: 'b@x.com', Username: 'fw22_0771', name: ' Deepak Yadav ' } });
    expect(prisma.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ name: 'Deepak Yadav' }) }));
  });
});
