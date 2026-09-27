import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession, type AppSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadDatasetForSession } from '@/lib/records/datasetAccess';
import { spreadsheetIdFromUrl } from '@/lib/sheets/plan';
import { normalizeFieldKey } from '@/lib/signing/fields';
import {
  explainSheetsError,
  hasSheetsScope,
  inspectSpreadsheet,
  parseSheetSync,
  syncDatasetWithSheet,
  type SheetSyncConfig,
} from '@/lib/sheets/sync';

export const maxDuration = 60;

async function callerGoogle(session: AppSession) {
  const account = await prisma.emailProviderAccount.findFirst({
    where: { userId: session.userId, provider: 'GMAIL', status: 'CONNECTED' },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, emailAddress: true, scope: true },
  });
  return account ? { accountId: account.id, email: account.emailAddress, hasSheets: hasSheetsScope(account.scope) } : null;
}

async function load(session: AppSession, id: string) {
  const dataset = await loadDatasetForSession(session, id);
  if (!dataset) return null;
  return dataset;
}

/** GET — the dataset's sheet connection plus whether the caller can connect one. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const dataset = await load(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const config = parseSheetSync(dataset.sheetSync);
  const connectedBy = config ? await prisma.user.findUnique({ where: { id: config.connectedById }, select: { name: true } }) : null;
  return NextResponse.json({
    config: config && { ...config, connectedByName: connectedBy?.name ?? null },
    google: await callerGoogle(session),
    connectUrl: `/api/gmail/connect?with=sheets&return=${encodeURIComponent(`/data/${dataset.id}?sheet=1`)}`,
  });
});

const postSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect'), url: z.string().min(1), sheetName: z.string().optional() }),
  z.object({ action: z.literal('connect'), url: z.string().min(1), sheetName: z.string().min(1), keyHeader: z.string().min(1) }),
  z.object({ action: z.literal('sync') }),
  z.object({ action: z.literal('enable'), enabled: z.boolean() }),
  z.object({ action: z.literal('disconnect') }),
]);

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const dataset = await load(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (dataset.workspaceId !== session.workspaceId) {
    return NextResponse.json({ error: 'Open this dataset from its own workspace to change its sheet.' }, { status: 403 });
  }
  const body = postSchema.parse(await req.json());
  const config = parseSheetSync(dataset.sheetSync);

  if (body.action === 'inspect' || body.action === 'connect') {
    const google = await callerGoogle(session);
    if (!google?.hasSheets) return NextResponse.json({ error: 'Connect Google Sheets first.', needsConnect: true }, { status: 400 });
    const spreadsheetId = spreadsheetIdFromUrl(body.url);
    if (!spreadsheetId) return NextResponse.json({ error: 'Paste a Google Sheets link (docs.google.com/spreadsheets/d/…).' }, { status: 400 });

    let info: Awaited<ReturnType<typeof inspectSpreadsheet>>;
    try {
      info = await inspectSpreadsheet(google.accountId, spreadsheetId, body.sheetName);
    } catch (err) {
      return NextResponse.json({ error: explainSheetsError(err) }, { status: 400 });
    }
    if (body.action === 'inspect') return NextResponse.json(info);

    if (info.tab !== body.sheetName) return NextResponse.json({ error: `No tab named "${body.sheetName}".` }, { status: 400 });
    if (!info.headers.some((h) => normalizeFieldKey(h) === normalizeFieldKey(body.keyHeader))) {
      return NextResponse.json({ error: `Row 1 of "${body.sheetName}" has no "${body.keyHeader}" column.` }, { status: 400 });
    }
    const next: SheetSyncConfig = {
      spreadsheetId,
      spreadsheetTitle: info.title,
      sheetName: body.sheetName,
      keyHeader: body.keyHeader,
      accountId: google.accountId,
      connectedById: session.userId,
      connectedAt: new Date().toISOString(),
      enabled: true,
      lastSyncedAt: null,
      lastResult: null,
    };
    await prisma.dataset.update({ where: { id: dataset.id }, data: { sheetSync: next as unknown as Prisma.InputJsonValue } });
    await audit(session, 'SHEET_SYNC_CONNECTED', {
      targetType: 'Dataset',
      targetId: dataset.id,
      metadata: { spreadsheetId, sheetName: body.sheetName, keyHeader: body.keyHeader },
    });
    const result = await syncDatasetWithSheet(dataset.id, { actorId: session.userId });
    return NextResponse.json({ result });
  }

  if (!config) return NextResponse.json({ error: 'This dataset is not connected to a sheet.' }, { status: 400 });

  if (body.action === 'sync') {
    const result = await syncDatasetWithSheet(dataset.id, { actorId: session.userId });
    await audit(session, 'SHEET_SYNC_RUN', { targetType: 'Dataset', targetId: dataset.id, metadata: { ok: result.ok, created: result.created, updated: result.updated, pushed: result.pushedCells } });
    return NextResponse.json({ result });
  }
  if (body.action === 'enable') {
    await prisma.dataset.update({ where: { id: dataset.id }, data: { sheetSync: { ...config, enabled: body.enabled } as unknown as Prisma.InputJsonValue } });
    await audit(session, body.enabled ? 'SHEET_SYNC_RESUMED' : 'SHEET_SYNC_PAUSED', { targetType: 'Dataset', targetId: dataset.id });
    return NextResponse.json({ ok: true });
  }
  await prisma.dataset.update({ where: { id: dataset.id }, data: { sheetSync: Prisma.DbNull } });
  await audit(session, 'SHEET_SYNC_DISCONNECTED', { targetType: 'Dataset', targetId: dataset.id, metadata: { spreadsheetId: config.spreadsheetId } });
  return NextResponse.json({ ok: true });
});
