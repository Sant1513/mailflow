import { google, type sheets_v4 } from 'googleapis';
import { z } from 'zod';
import { ColumnType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { authorizedClientFor, SHEETS_OAUTH_SCOPE } from '@/lib/gmail/oauth';
import { ensureColumns, updateRecordFields } from '@/lib/records/systemUpdate';
import { findOrCreateContactForRecord } from '@/lib/records/contactLink';
import { onRecordChanged } from '@/lib/automation/runner';
import { SIGNING_COLUMNS } from '@/lib/signing/writeback';
import { columnLetter, defaultDisplay, planSync, quoteSheet, type OwnedColumn } from '@/lib/sheets/plan';

export const SHEETS_SCOPE = SHEETS_OAUTH_SCOPE;
export const SHEETS_REASON = 'Google Sheets sync';
const MAX_ROWS = 5000;

export const sheetSyncSchema = z.object({
  spreadsheetId: z.string().min(10),
  spreadsheetTitle: z.string().default(''),
  sheetName: z.string().min(1),
  keyHeader: z.string().min(1),
  /** The Google connection (a Gmail account with Sheets access) used to read and write. */
  accountId: z.string().min(1),
  connectedById: z.string().min(1),
  connectedAt: z.string(),
  enabled: z.boolean().default(true),
  lastSyncedAt: z.string().nullable().default(null),
  lastResult: z
    .object({
      at: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      created: z.number().default(0),
      updated: z.number().default(0),
      pushedCells: z.number().default(0),
      appended: z.number().default(0),
      duplicateKeys: z.number().default(0),
      partial: z.boolean().default(false),
    })
    .nullable()
    .default(null),
});
export type SheetSyncConfig = z.infer<typeof sheetSyncSchema>;
export type SheetSyncResult = NonNullable<SheetSyncConfig['lastResult']>;

export function parseSheetSync(raw: unknown): SheetSyncConfig | null {
  if (!raw) return null;
  const parsed = sheetSyncSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function hasSheetsScope(scope: string | null | undefined): boolean {
  return (scope ?? '').split(/\s+/).includes(SHEETS_SCOPE);
}

/** Columns MailFlow writes itself; they always flow MailFlow → sheet. */
export const OWNED_COLUMNS: OwnedColumn[] = Object.values(SIGNING_COLUMNS).map((c) => ({ key: c.key, label: c.label }));

const DATETIME_KEYS = new Set(Object.values(SIGNING_COLUMNS).filter((c) => c.type === ColumnType.DATETIME).map((c) => c.key));

/** Dates MailFlow writes read as "2026-09-27 14:05" (IST) in the sheet, which Sheets parses as a date. */
function displayForSheet(v: unknown, key: string): string {
  if (DATETIME_KEYS.has(key) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      const ist = new Date(d.getTime() + 330 * 60_000);
      return ist.toISOString().slice(0, 16).replace('T', ' ');
    }
  }
  return defaultDisplay(v);
}

export async function sheetsClientFor(accountId: string): Promise<sheets_v4.Sheets> {
  const account = await prisma.emailProviderAccount.findUnique({ where: { id: accountId } });
  if (!account || account.status !== 'CONNECTED') throw new SheetsError('The Google account used for this sheet is not connected. Reconnect it in Settings.');
  if (!hasSheetsScope(account.scope)) throw new SheetsError('That Google account has not granted Sheets access. Use "Connect Google Sheets".');
  const auth = await authorizedClientFor(account);
  return google.sheets({ version: 'v4', auth });
}

export class SheetsError extends Error {}

/** Friendly text for the errors Google returns most often. */
export function explainSheetsError(err: unknown): string {
  if (err instanceof SheetsError) return err.message;
  const e = err as { code?: number; message?: string; errors?: { reason?: string }[] };
  const msg = e?.message ?? String(err);
  if (/has not been used in project|SERVICE_DISABLED|accessNotConfigured/i.test(msg)) {
    const project = /project\s+(\d+)/.exec(msg)?.[1];
    return `The Google Sheets API is not enabled for this app's Google Cloud project. Enable it at https://console.developers.google.com/apis/api/sheets.googleapis.com/overview${project ? `?project=${project}` : ''} and try again.`;
  }
  if (e?.code === 404) return 'Spreadsheet or tab not found. Check the link and the tab name.';
  if (e?.code === 403) return 'This Google account cannot open that spreadsheet. Share it with the account (Editor access to write back).';
  if (/Unable to parse range/i.test(msg)) return 'That tab was not found in the spreadsheet.';
  if (/invalid_grant/i.test(msg)) return 'Google access has expired. Reconnect Google Sheets.';
  return msg.slice(0, 300);
}

/** Tabs and header row, for the connect form. */
export async function inspectSpreadsheet(accountId: string, spreadsheetId: string, sheetName?: string) {
  const sheets = await sheetsClientFor(accountId);
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'properties.title,sheets.properties.title' });
  const tabs = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? '').filter(Boolean);
  const tab = sheetName && tabs.includes(sheetName) ? sheetName : tabs[0] ?? '';
  let headers: string[] = [];
  let rowCount = 0;
  if (tab) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: quoteSheet(tab), valueRenderOption: 'FORMATTED_VALUE' });
    const values = (res.data.values ?? []) as string[][];
    headers = (values[0] ?? []).map((h) => String(h ?? '').trim()).filter(Boolean);
    rowCount = Math.max(0, values.length - 1);
  }
  return { title: meta.data.properties?.title ?? '', tabs, tab, headers, rowCount };
}

async function saveResult(datasetId: string, config: SheetSyncConfig, result: SheetSyncResult, syncedAt: string | null) {
  const next: SheetSyncConfig = { ...config, lastResult: result, ...(syncedAt ? { lastSyncedAt: syncedAt } : {}) };
  await prisma.dataset.update({ where: { id: datasetId }, data: { sheetSync: next as unknown as Prisma.InputJsonValue } });
}

/**
 * One sync pass for a dataset. Never throws: failures are stored on the
 * dataset's sheetSync.lastResult and returned. On the very first pass rows
 * are imported without running automations, so connecting a sheet can't
 * trigger a flood of emails.
 */
export async function syncDatasetWithSheet(datasetId: string, opts: { actorId?: string | null; budgetMs?: number } = {}): Promise<SheetSyncResult> {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + (opts.budgetMs ?? 45_000);
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId }, select: { id: true, organizationId: true, workspaceId: true, sheetSync: true } });
  const config = parseSheetSync(dataset?.sheetSync);
  const base: SheetSyncResult = { at: startedAt.toISOString(), ok: false, created: 0, updated: 0, pushedCells: 0, appended: 0, duplicateKeys: 0, partial: false };
  if (!dataset || !config) return { ...base, error: 'This dataset is not connected to a sheet.' };

  try {
    const sheets = await sheetsClientFor(config.accountId);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: quoteSheet(config.sheetName),
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const values = ((res.data.values ?? []) as unknown[][]).slice(0, MAX_ROWS + 1).map((r) => r.map((c) => String(c ?? '')));

    const [columns, records] = await Promise.all([
      prisma.datasetColumn.findMany({ where: { datasetId }, select: { key: true, label: true, type: true } }),
      prisma.record.findMany({ where: { datasetId }, take: MAX_ROWS, orderBy: { createdAt: 'asc' }, select: { id: true, data: true, createdAt: true } }),
    ]);

    const firstSync = !config.lastSyncedAt;
    const editedSince = new Map<string, Set<string>>();
    if (!firstSync) {
      const history = await prisma.recordChangeHistory.findMany({
        where: {
          record: { datasetId },
          createdAt: { gt: new Date(config.lastSyncedAt!) },
          OR: [{ reason: null }, { reason: { not: SHEETS_REASON } }],
        },
        select: { recordId: true, field: true },
      });
      for (const h of history) {
        if (!editedSince.has(h.recordId)) editedSince.set(h.recordId, new Set());
        editedSince.get(h.recordId)!.add(h.field);
      }
    }

    const plan = planSync({
      values,
      columns: columns.map((c) => ({ key: c.key, label: c.label, type: c.type })),
      records: records.map((r) => ({ id: r.id, data: (r.data ?? {}) as Record<string, unknown>, createdAt: r.createdAt })),
      keyHeader: config.keyHeader,
      owned: OWNED_COLUMNS,
      editedSince,
      connectedAt: new Date(config.connectedAt),
      display: displayForSheet,
    });
    if (plan.error) {
      const result = { ...base, error: plan.error };
      await saveResult(datasetId, config, result, null);
      return result;
    }

    const result: SheetSyncResult = { ...base, ok: true, duplicateKeys: plan.duplicateKeys };

    // MailFlow → sheet first: one batch call, cheap and never partial.
    if (plan.cellWrites.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: config.spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: plan.cellWrites.map((w) => ({ range: `${quoteSheet(config.sheetName)}!${columnLetter(w.col)}${w.row + 1}`, values: [[w.value]] })),
        },
      });
      result.pushedCells = plan.cellWrites.length;
    }
    if (plan.appendRows.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: config.spreadsheetId,
        range: quoteSheet(config.sheetName),
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: plan.appendRows },
      });
      result.appended = plan.appendRows.length;
    }

    // Sheet → MailFlow.
    if (plan.newColumns.length) {
      await ensureColumns(datasetId, plan.newColumns.map((c) => ({ key: c.key, label: c.label, type: ColumnType.TEXT })));
    }
    for (const c of plan.recordCreates) {
      if (Date.now() > deadline) {
        result.partial = true;
        break;
      }
      const contactId = await findOrCreateContactForRecord({
        organizationId: dataset.organizationId,
        workspaceId: dataset.workspaceId,
        datasetId,
        data: c.data,
      }).catch(() => null);
      const record = await prisma.record.create({ data: { datasetId, data: c.data as Prisma.InputJsonValue, contactId } });
      result.created++;
      if (!firstSync) {
        await onRecordChanged({ recordId: record.id, datasetId, workspaceId: dataset.workspaceId, triggerType: 'RECORD_CREATED' }).catch((e) =>
          console.error('[sheets] automation after create failed', e),
        );
      }
    }
    for (const u of plan.recordUpdates) {
      if (Date.now() > deadline) {
        result.partial = true;
        break;
      }
      const { changed } = await updateRecordFields({
        recordId: u.recordId,
        fields: u.fields,
        reason: SHEETS_REASON,
        actorId: opts.actorId ?? null,
        runAutomations: !firstSync,
      });
      if (changed.length) result.updated++;
    }

    // A partial pass keeps the old sync time, so the next pass re-plans the rest.
    await saveResult(datasetId, config, result, result.partial ? null : startedAt.toISOString());
    return result;
  } catch (err) {
    const result = { ...base, error: explainSheetsError(err) };
    console.error('[sheets] sync failed', { datasetId, err: (err as Error).message });
    await saveResult(datasetId, config, result, null).catch(() => undefined);
    return result;
  }
}

/** Cron: every enabled sheet, least recently synced first, within one time budget. */
export async function syncAllSheets(budgetMs = 50_000): Promise<{ datasets: number; ok: number; failed: number; skipped: number }> {
  const deadline = Date.now() + budgetMs;
  const rows = await prisma.dataset.findMany({ select: { id: true, sheetSync: true } });
  const connected = rows
    .map((r) => ({ id: r.id, config: parseSheetSync(r.sheetSync) }))
    .filter((r): r is { id: string; config: SheetSyncConfig } => !!r.config && r.config.enabled)
    .sort((a, b) => (a.config.lastSyncedAt ?? '').localeCompare(b.config.lastSyncedAt ?? ''));
  const out = { datasets: connected.length, ok: 0, failed: 0, skipped: 0 };
  for (const d of connected) {
    const left = deadline - Date.now();
    if (left < 8_000) {
      out.skipped++;
      continue;
    }
    const r = await syncDatasetWithSheet(d.id, { budgetMs: Math.min(40_000, left - 5_000) });
    if (r.ok) out.ok++;
    else out.failed++;
  }
  return out;
}
