import { ColumnType } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { appBaseUrl } from '@/lib/app-url';
import { ensureColumns, updateRecordFields, type ColumnSpec } from '@/lib/records/systemUpdate';

/**
 * Signing status written back to the dataset row a document was sent from
 * (Sign → "Send for signature" from Data). The link lives in the request's
 * internal field values (__recordId / __datasetId), so no schema change is
 * needed. Automations then react with ordinary conditions, e.g.
 * "Signing status = Signed" or "Days waiting to sign ≥ 3".
 */

export const SIGNING_COLUMNS = {
  status: { key: 'signing_status', label: 'Signing status', type: ColumnType.TEXT },
  document: { key: 'signing_document', label: 'Signing document', type: ColumnType.TEXT },
  sentAt: { key: 'signing_sent_at', label: 'Sent for signature', type: ColumnType.DATETIME },
  signedAt: { key: 'signed_at', label: 'Signed at', type: ColumnType.DATETIME },
  link: { key: 'signed_document_url', label: 'Signed document', type: ColumnType.URL },
  daysWaiting: { key: 'days_waiting_to_sign', label: 'Days waiting to sign', type: ColumnType.NUMBER },
} satisfies Record<string, ColumnSpec>;

export const SIGNING_COLUMN_KEYS = Object.values(SIGNING_COLUMNS).map((c) => c.key);

type Member = {
  status: string;
  signerOrder: number;
  sentAt: Date | null;
  signedAt: Date | null;
  token: string;
};

export interface DocumentState {
  status: string;
  sentAt: Date | null;
  signedAt: Date | null;
  leadToken: string;
  daysWaiting: number | null;
}

/** Whole-document status for one request or a multi-signer group. Pure, for testing. */
export function documentState(members: Member[], groupStatus: string | null, now: Date = new Date()): DocumentState {
  const sorted = [...members].sort((a, b) => a.signerOrder - b.signerOrder);
  const lead = sorted[0]!;
  const signed = sorted.filter((m) => m.status === 'SIGNED');
  const total = sorted.length;
  const allSigned = total > 0 && signed.length === total;
  const sentAt = sorted.map((m) => m.sentAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

  let status: string;
  if (groupStatus === 'VOIDED' || sorted.every((m) => m.status === 'VOIDED')) status = 'Voided';
  else if (allSigned || groupStatus === 'COMPLETED') status = 'Signed';
  else if (sorted.some((m) => m.status === 'EXPIRED')) status = 'Expired';
  else if (signed.length > 0) status = `Signed ${signed.length}/${total}`;
  else if (sorted.some((m) => m.status === 'VIEWED')) status = 'Viewed';
  else if (sorted.some((m) => m.status === 'SENT')) status = 'Sent';
  else status = 'Draft';

  const done = status === 'Signed';
  const signedAt = done
    ? signed.map((m) => m.signedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    : null;
  const waiting = !done && status !== 'Voided' && status !== 'Expired' && sentAt;
  return {
    status,
    sentAt,
    signedAt,
    leadToken: lead.token,
    daysWaiting: waiting ? Math.floor((now.getTime() - sentAt.getTime()) / 86_400_000) : null,
  };
}

function linkOf(fieldValues: unknown): { recordId: string; datasetId: string } | null {
  if (!fieldValues || typeof fieldValues !== 'object') return null;
  const v = fieldValues as Record<string, unknown>;
  return typeof v.__recordId === 'string' && typeof v.__datasetId === 'string' ? { recordId: v.__recordId, datasetId: v.__datasetId } : null;
}

/**
 * Brings the source row up to date for the document a request belongs to.
 * Safe to call after any status change; a request not sent from Data is a
 * no-op. Never throws — signing must not fail because of a data write.
 */
export async function syncSigningStatusToRecord(requestId: string, now: Date = new Date()): Promise<void> {
  try {
    const request = await prisma.signingRequest.findUnique({
      where: { id: requestId },
      select: { id: true, title: true, workspaceId: true, groupId: true, fieldValues: true, status: true, signerOrder: true, sentAt: true, signedAt: true, token: true, group: { select: { status: true } } },
    });
    if (!request) return;
    const link = linkOf(request.fieldValues);
    if (!link) return;

    // The row must belong to the same workspace as the document.
    const record = await prisma.record.findFirst({
      where: { id: link.recordId, datasetId: link.datasetId, dataset: { workspaceId: request.workspaceId } },
      select: { id: true },
    });
    if (!record) return;

    const members: Member[] = request.groupId
      ? await prisma.signingRequest.findMany({
          where: { groupId: request.groupId },
          select: { status: true, signerOrder: true, sentAt: true, signedAt: true, token: true },
        })
      : [request];
    const state = documentState(members, request.group?.status ?? null, now);

    await ensureColumns(link.datasetId, Object.values(SIGNING_COLUMNS));
    await updateRecordFields({
      recordId: record.id,
      reason: 'E-signature',
      fields: {
        [SIGNING_COLUMNS.status.key]: state.status,
        [SIGNING_COLUMNS.document.key]: request.title,
        [SIGNING_COLUMNS.sentAt.key]: state.sentAt?.toISOString() ?? null,
        [SIGNING_COLUMNS.signedAt.key]: state.signedAt?.toISOString() ?? null,
        [SIGNING_COLUMNS.link.key]: state.status === 'Signed' ? `${appBaseUrl()}/api/sign/${state.leadToken}/download?format=pdf` : null,
        [SIGNING_COLUMNS.daysWaiting.key]: state.daysWaiting,
      },
    });
  } catch (err) {
    console.error('[signing] could not write status back to the data row', requestId, err);
  }
}

/**
 * Daily refresh of "Days waiting to sign" for documents still out, so
 * "not signed after N days" automations fire. One request per document.
 */
export async function refreshWaitingDocuments(now: Date = new Date()): Promise<number> {
  const open = await prisma.signingRequest.findMany({
    where: { status: { in: ['SENT', 'VIEWED', 'DRAFT'] } },
    select: { id: true, groupId: true, fieldValues: true },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });
  const seen = new Set<string>();
  let refreshed = 0;
  for (const r of open) {
    if (!linkOf(r.fieldValues)) continue;
    const key = r.groupId ?? r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    await syncSigningStatusToRecord(r.id, now);
    refreshed++;
  }
  return refreshed;
}
