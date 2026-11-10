import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/system/serverState', () => ({ controlDb: () => ({ systemState: { findUnique: async () => null } }) }));
const { isOwnAttachmentRef, isLegacyBlobUrl, readRef } = await import('@/lib/storage/files');

describe('attachment references sent by the browser', () => {
  it('accepts only this workspace’s own uploads', () => {
    expect(isOwnAttachmentRef('storage:signing-attachments/ws1/170-offer.pdf', 'ws1')).toBe(true);
    expect(isOwnAttachmentRef('archive:signing-attachments/ws1/170-offer.pdf', 'ws1')).toBe(true);
    expect(isOwnAttachmentRef('https://abc.public.blob.vercel-storage.com/signing-attachments/ws1/a-x1.pdf', 'ws1')).toBe(true);
  });

  it('refuses other workspaces, signed PDFs, traversal and arbitrary URLs', () => {
    expect(isOwnAttachmentRef('storage:signing-attachments/ws2/170-offer.pdf', 'ws1')).toBe(false);
    expect(isOwnAttachmentRef('storage:signed/req123.pdf', 'ws1')).toBe(false);
    expect(isOwnAttachmentRef('storage:signing-attachments/ws1/../ws2/x.pdf', 'ws1')).toBe(false);
    expect(isOwnAttachmentRef('storage:signing-attachments/ws10/x.pdf', 'ws1')).toBe(false);
    expect(isOwnAttachmentRef('http://localhost:3200/api/secret', 'ws1')).toBe(false);
    expect(isOwnAttachmentRef('https://evil.example.com/signing-attachments/ws1/x.pdf', 'ws1')).toBe(false);
    expect(isOwnAttachmentRef('https://x.blob.vercel-storage.com.evil.com/signing-attachments/ws1/x.pdf', 'ws1')).toBe(false);
    expect(isOwnAttachmentRef('JVBERi0xLjQ=', 'ws1')).toBe(false);
  });

  it('recognises only https Vercel Blob links as legacy files', () => {
    expect(isLegacyBlobUrl('https://abc.public.blob.vercel-storage.com/x.pdf')).toBe(true);
    expect(isLegacyBlobUrl('http://abc.public.blob.vercel-storage.com/x.pdf')).toBe(false);
    expect(isLegacyBlobUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isLegacyBlobUrl('not a url')).toBe(false);
  });
});

describe('readRef never fetches an arbitrary address', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns null without any request for non-Blob URLs', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await readRef('http://localhost:3200/internal')).toBeNull();
    expect(await readRef('https://example.com/file.pdf')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still reads old Vercel Blob attachments', async () => {
    const fetchSpy = vi.fn(async () => new Response('PDF'));
    vi.stubGlobal('fetch', fetchSpy);
    expect((await readRef('https://abc.public.blob.vercel-storage.com/signing-attachments/ws1/a.pdf'))?.toString()).toBe('PDF');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
