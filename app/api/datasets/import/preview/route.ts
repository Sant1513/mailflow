import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import {
  parsePastedText,
  parseCsvFile,
  parseXlsxFile,
  inferColumnTypes,
  guessEmailColumn,
  analyzeDuplicates,
} from '@/lib/imports/parse';

/**
 * §15: paste / CSV / XLSX preview. This endpoint NEVER touches the
 * database and NEVER sends email — it only parses and analyzes so the user
 * can review before committing via POST /api/datasets/import.
 */
const pasteSchema = z.object({ mode: z.literal('paste'), text: z.string().min(1) });

export const POST = withErrorHandling(async (req) => {
  await requireSession();
  const contentType = req.headers.get('content-type') ?? '';

  let table;
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    table = file.name.endsWith('.xlsx') ? parseXlsxFile(buffer) : parseCsvFile(buffer);
  } else {
    const body = pasteSchema.parse(await req.json());
    table = parsePastedText(body.text);
  }

  if (table.headers.length === 0) {
    return NextResponse.json({ error: 'No columns detected in the pasted/uploaded data' }, { status: 400 });
  }

  const types = inferColumnTypes(table);
  const emailColumn = guessEmailColumn(table.headers);
  const duplicates = emailColumn ? analyzeDuplicates(table, emailColumn) : null;

  return NextResponse.json({
    headers: table.headers,
    rowCount: table.rows.length,
    // Full parsed rows are returned (not just a sample) so the client can
    // submit them straight to POST /api/datasets/import without re-parsing
    // or re-uploading the source file. Datasets here are hundreds, not
    // millions, of rows — fine to round-trip through the browser.
    rows: table.rows,
    sampleRows: table.rows.slice(0, 20),
    inferredTypes: types,
    suggestedEmailColumn: emailColumn,
    duplicates,
  });
});
