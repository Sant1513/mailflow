import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/system/serverState', () => ({ controlDb: () => ({ systemState: { findUnique: async () => null } }) }));
const { archiveSignature, pdfBase64, readRef, storePdf, storageEnabled } = await import('@/lib/storage/files');

describe('file storage', () => {
  it('signs archive links per path and expiry', () => {
    const a = archiveSignature('signed/r1.pdf', 1000, 'secret');
    expect(a).toHaveLength(32);
    expect(archiveSignature('signed/r1.pdf', 1000, 'secret')).toBe(a);
    expect(archiveSignature('signed/r2.pdf', 1000, 'secret')).not.toBe(a);
    expect(archiveSignature('signed/r1.pdf', 1001, 'secret')).not.toBe(a);
  });

  it('keeps reading older PDFs stored inline as base64', async () => {
    const b64 = Buffer.from('%PDF-1.7 test').toString('base64');
    expect(await pdfBase64(b64)).toBe(b64);
    expect((await readRef(b64))?.toString()).toBe('%PDF-1.7 test');
    expect(await pdfBase64(null)).toBeNull();
  });

  it('without storage set up, new PDFs stay inline and archived files report unavailable', async () => {
    expect(storageEnabled()).toBe(false);
    expect(await storePdf('signed/x.pdf', Buffer.from('pdf'))).toBe(Buffer.from('pdf').toString('base64'));
    expect(await readRef('archive:signed/x.pdf')).toBeNull(); // no laptop address known
    expect(await readRef('storage:signed/x.pdf')).toBeNull();
  });
});
