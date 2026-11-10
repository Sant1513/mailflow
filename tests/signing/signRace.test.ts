import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/sign/[token]: a double-click (or two tabs) must sign once, render one PDF and count
// once towards a group. The signature is claimed with a conditional write before anything else.
const db = {
  request: null as Record<string, unknown> | null,
  claimCount: 1,
  updates: [] as unknown[],
  groupSigned: 1,
  groupFlip: 1,
  groupUpdates: [] as unknown[],
};

const prisma = {
  signingRequest: {
    findUnique: vi.fn(async () => db.request),
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: db.claimCount })),
    update: vi.fn(async (args: unknown) => {
      db.updates.push(args);
      return {};
    }),
    count: vi.fn(async () => db.groupSigned),
  },
  signingGroup: {
    findUnique: vi.fn(async () => ({ id: 'g1', totalSigners: 2, signedCount: 0, signingOrder: 'PARALLEL', status: 'IN_PROGRESS' })),
    updateMany: vi.fn(async (args: unknown) => {
      db.groupUpdates.push(args);
      return { count: db.groupFlip };
    }),
    update: vi.fn(async () => ({})),
  },
  signingBatch: { update: vi.fn(async () => ({})) },
  emailProviderAccount: { findFirst: vi.fn(async () => null) },
  workspace: { findUnique: vi.fn(async () => null) },
};
vi.mock('@/lib/db/client', () => ({ prisma }));
const generateSignedPdf = vi.fn(async () => Buffer.from('%PDF'));
vi.mock('@/lib/documents/pdf', () => ({ generateSignedPdf }));
vi.mock('@/lib/storage/files', () => ({ attachmentsForEmail: async () => [], pdfBase64: async () => null, storePdf: async () => 'storage:signed/x.pdf' }));
vi.mock('@/lib/signing/writeback', () => ({ syncSigningStatusToRecord: async () => undefined }));
vi.mock('@/lib/audit/log', () => ({ audit: async () => undefined }));
vi.mock('@/lib/email/gmail', () => ({ GmailProvider: class {} }));

const { POST } = await import('@/app/api/sign/[token]/route');

const call = () =>
  POST(new Request('https://mailflow.test/api/sign/tok', { method: 'POST', body: JSON.stringify({ signatureImage: 'data:image/png;base64,AA', signerName: 'Asha' }) }), { params: { token: 'tok' } });

describe('signing submit is claimed atomically', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.request = { id: 'r1', status: 'SENT', title: 'Offer', content: '<p>x</p>', recipientName: 'Asha', recipientEmail: 'a@x.com', fieldValues: {}, assignedFields: [], signerOrder: 0, signerRole: null, groupId: null, batchId: null, workspaceId: 'w1', expiresAt: null, sentAt: null, ccEmails: [], attachments: [] };
    db.claimCount = 1;
    db.updates = [];
    db.groupUpdates = [];
  });

  it('claims SENT/VIEWED → SIGNED with a conditional write, then renders once', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(prisma.signingRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1', status: { notIn: ['SIGNED', 'VOIDED', 'EXPIRED'] } } }));
    expect(generateSignedPdf).toHaveBeenCalledOnce();
  });

  it('a second, simultaneous submit gets 409 and renders nothing', async () => {
    db.claimCount = 0; // the other request already flipped it
    const res = await call();
    expect(res.status).toBe(409);
    expect(generateSignedPdf).not.toHaveBeenCalled();
  });

  it('undoes the claim when the PDF fails, so the signer can try again', async () => {
    generateSignedPdf.mockRejectedValueOnce(new Error('chromium crashed'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(db.updates).toContainEqual(expect.objectContaining({ where: { id: 'r1' }, data: expect.objectContaining({ status: 'SENT', signedAt: null }) }));
  });

  it('counts group signatures instead of incrementing, and only one call completes the group', async () => {
    db.request = { ...db.request!, groupId: 'g1' };
    db.groupSigned = 2; // both signers are SIGNED now
    db.groupFlip = 0; // …but the other request already marked the group COMPLETED
    const res = await call();
    expect(res.status).toBe(200);
    expect(db.groupUpdates[0]).toEqual({ where: { id: 'g1', status: { notIn: ['COMPLETED', 'VOIDED'] } }, data: { signedCount: 2, status: 'COMPLETED' } });
    // Not the one that completed it: no combined PDF (only this signer's own PDF was rendered).
    expect(generateSignedPdf).toHaveBeenCalledOnce();
  });
});
