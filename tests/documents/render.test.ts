import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, degrees, PDFArray } from 'pdf-lib';
import { inspectPdf, DocumentFileError } from '@/lib/documents/inspect';
import { renderDocument, DocumentRenderError, toWinAnsi, fitSingleLine, wrapLines, type RenderDocumentInput } from '@/lib/documents/render';
import { documentFieldSchema, type DocumentFieldInput } from '@/lib/documents/types';

async function formPdf(options: { rotateSecondPage?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  if (options.rotateSecondPage) p2.setRotation(degrees(90));
  const form = doc.getForm();
  form.createTextField('student_name').addToPage(p1, { x: 100, y: 700, width: 200, height: 20 });
  form.createCheckBox('agree').addToPage(p1, { x: 100, y: 650, width: 12, height: 12 });
  const batch = form.createDropdown('batch');
  batch.addOptions(['FT-WEB-12', 'FT-WEB-13']);
  batch.addToPage(p1, { x: 100, y: 600, width: 150, height: 20 });
  const track = form.createRadioGroup('track');
  track.addOptionToPage('Web', p1, { x: 100, y: 550, width: 12, height: 12 });
  track.addOptionToPage('Data', p1, { x: 130, y: 550, width: 12, height: 12 });
  const code = form.createTextField('code');
  code.setMaxLength(4);
  code.addToPage(p2, { x: 50, y: 50, width: 100, height: 20 });
  return doc.save();
}

async function flatPdf(rotation = 0) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  if (rotation) page.setRotation(degrees(rotation));
  page.drawText('AGREEMENT', { x: 50, y: 800, size: 14 });
  return doc.save();
}

const f = (over: Partial<DocumentFieldInput> & { id: string }) =>
  documentFieldSchema.parse({ label: over.id, value: '', target: { kind: 'form', fieldName: over.id }, ...over });

const baseInput = (fileBytes: Uint8Array, over: Partial<RenderDocumentInput> = {}): RenderDocumentInput => ({
  fileBytes,
  fields: [],
  values: {},
  lockMode: 'EDITABLE',
  stamp: null,
  metadata: { title: 'Agreement - Rahul', subject: 'Agreement', reference: 'MF-TEST0001', issuedAt: new Date('2026-09-10T04:30:00Z') },
  ...over,
});

const formFields = [
  f({ id: 'name', target: { kind: 'form', fieldName: 'student_name' } }),
  f({ id: 'agree', target: { kind: 'form', fieldName: 'agree' } }),
  f({ id: 'batch', target: { kind: 'form', fieldName: 'batch' } }),
  f({ id: 'track', target: { kind: 'form', fieldName: 'track' } }),
];
const formValues = { name: 'Rahul Sharma', agree: 'Yes', batch: 'ft-web-13', track: 'Data' };

/** Decoded content streams of a page, for asserting drawn text. */
function pageContent(doc: PDFDocument, index: number): string {
  const page = doc.getPage(index);
  const contents = page.node.get(PDFName.of('Contents'));
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs
    .map((ref) => doc.context.lookup(ref as never))
    .map((stream) => {
      if (!(stream instanceof PDFRawStream)) return '';
      const raw = Buffer.from(stream.getContents());
      const filter = stream.dict.get(PDFName.of('Filter'));
      return (filter ? zlib.inflateSync(raw) : raw).toString('latin1');
    })
    .join('\n');
}

const hex = (text: string) => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

describe('inspectPdf', () => {
  it('reads pages and every form field with type, options and top-left rectangle', async () => {
    const info = await inspectPdf(await formPdf());
    expect(info.pageCount).toBe(2);
    expect(info.pages[0]).toEqual({ width: 612, height: 792, rotation: 0 });
    const name = info.formFields.find((x) => x.name === 'student_name');
    // pdf-lib pads the widget rectangle by half its 1pt border on each side.
    expect(name).toMatchObject({ type: 'text', page: 0, rect: { x: 99.5, y: 71.5, width: 201, height: 21 } });
    expect(info.formFields.find((x) => x.name === 'batch')?.options).toEqual(['FT-WEB-12', 'FT-WEB-13']);
    expect(info.formFields.find((x) => x.name === 'code')).toMatchObject({ page: 1, maxLength: 4 });
    expect(info.formFields.find((x) => x.name === 'track')?.type).toBe('radio');
    expect(info.hasXfa).toBe(false);
  });

  it('reports rotation and does not guess rectangles on rotated pages', async () => {
    const info = await inspectPdf(await formPdf({ rotateSecondPage: true }));
    expect(info.pages[1]?.rotation).toBe(90);
    expect(info.formFields.find((x) => x.name === 'code')).toMatchObject({ page: 1, rect: null });
  });

  it('rejects files that are not PDFs', async () => {
    await expect(inspectPdf(new TextEncoder().encode('hello world'))).rejects.toBeInstanceOf(DocumentFileError);
  });
});

describe('renderDocument — form fields', () => {
  it('fills text, checkbox, dropdown (case-insensitive) and radio fields, leaving them editable', async () => {
    const out = await renderDocument(baseInput(await formPdf(), { fields: formFields, values: formValues }));
    const doc = await PDFDocument.load(out.bytes);
    const form = doc.getForm();
    expect(form.getTextField('student_name').getText()).toBe('Rahul Sharma');
    expect(form.getCheckBox('agree').isChecked()).toBe(true);
    expect(form.getDropdown('batch').getSelected()).toEqual(['FT-WEB-13']);
    expect(form.getRadioGroup('track').getSelected()).toBe('Data');
    expect(form.getTextField('student_name').isReadOnly()).toBe(false);
    expect(out.warnings).toEqual([]);
  });

  it('locks only the filled fields in LOCK_FILLED mode', async () => {
    const out = await renderDocument(baseInput(await formPdf(), { fields: formFields, values: formValues, lockMode: 'LOCK_FILLED' }));
    const form = (await PDFDocument.load(out.bytes)).getForm();
    expect(form.getTextField('student_name').isReadOnly()).toBe(true);
    expect(form.getDropdown('batch').isReadOnly()).toBe(true);
    expect(form.getTextField('code').isReadOnly()).toBe(false);
  });

  it('removes every form field in FLATTEN mode', async () => {
    const out = await renderDocument(baseInput(await formPdf(), { fields: formFields, values: formValues, lockMode: 'FLATTEN' }));
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.getForm().getFields()).toHaveLength(0);
  });

  it('cuts text to the maxLength set in the PDF and says so', async () => {
    const out = await renderDocument(
      baseInput(await formPdf(), { fields: [f({ id: 'code', label: 'Code', target: { kind: 'form', fieldName: 'code' } })], values: { code: 'ABCDEFG' } })
    );
    expect((await PDFDocument.load(out.bytes)).getForm().getTextField('code').getText()).toBe('ABCD');
    expect(out.warnings[0]).toContain('cut to 4 characters');
  });

  it('refuses a dropdown value that is not an option', async () => {
    await expect(
      renderDocument(baseInput(await formPdf(), { fields: [f({ id: 'batch', label: 'Batch', target: { kind: 'form', fieldName: 'batch' } })], values: { batch: 'FT-DATA-1' } }))
    ).rejects.toThrow(/not one of the options/);
  });

  it('refuses a form field the PDF does not have', async () => {
    await expect(
      renderDocument(baseInput(await formPdf(), { fields: [f({ id: 'x', target: { kind: 'form', fieldName: 'missing_field' } })], values: { x: 'v' } }))
    ).rejects.toBeInstanceOf(DocumentRenderError);
  });
});

describe('renderDocument — text on page', () => {
  const box = (over: Partial<DocumentFieldInput> = {}) =>
    f({ id: 't1', label: 'Name', target: { kind: 'text', page: 0, x: 60, y: 120, width: 240, height: 22 }, ...over });

  it('draws the value inside the box', async () => {
    const out = await renderDocument(baseInput(await flatPdf(), { fields: [box()], values: { t1: 'Rahul Sharma' } }));
    const doc = await PDFDocument.load(out.bytes);
    expect(pageContent(doc, 0).toUpperCase()).toContain(hex('Rahul Sharma'));
  });

  it('shrinks long text to fit and only cuts it off as a last resort', async () => {
    const fits = await renderDocument(baseInput(await flatPdf(), { fields: [box()], values: { t1: 'Rahul Kumar Sharma of Bengaluru' } }));
    expect(fits.warnings).toEqual([]);
    const cut = await renderDocument(baseInput(await flatPdf(), { fields: [box()], values: { t1: 'x'.repeat(400) } }));
    expect(cut.warnings[0]).toContain('did not fit');
  });

  it('wraps multi-line values such as addresses', async () => {
    const field = box({ target: { kind: 'text', page: 0, x: 60, y: 120, width: 160, height: 60 }, style: { multiline: true, fontSize: 10 } });
    const out = await renderDocument(baseInput(await flatPdf(), { fields: [field], values: { t1: '12 MG Road\nIndiranagar, Bengaluru 560038' } }));
    const content = pageContent(await PDFDocument.load(out.bytes), 0).toUpperCase();
    expect(content).toContain(hex('12 MG Road'));
    expect(out.warnings).toEqual([]);
  });

  it('refuses text boxes on rotated pages', async () => {
    await expect(renderDocument(baseInput(await flatPdf(90), { fields: [box()], values: { t1: 'Rahul' } }))).rejects.toThrow(/rotated/);
  });
});

describe('renderDocument — stamp, metadata, determinism, characters', () => {
  const stamp = { reference: 'MF-TEST0001', recipient: 'rahul@example.com', issuedLabel: '10 Sep 2026' };

  it('prints the reference line on each page and sets metadata', async () => {
    const out = await renderDocument(baseInput(await formPdf(), { stamp }));
    const doc = await PDFDocument.load(out.bytes, { updateMetadata: false });
    expect(pageContent(doc, 1).toUpperCase()).toContain(hex('Ref MF-TEST0001'));
    expect(doc.getTitle()).toBe('Agreement - Rahul');
    expect(doc.getKeywords()).toContain('MF-TEST0001');
    expect(doc.getCreationDate()?.toISOString()).toBe('2026-09-10T04:30:00.000Z');
  });

  it('produces byte-identical output for the same inputs, and different output for different values', async () => {
    const file = await formPdf();
    const input = baseInput(file, { fields: formFields, values: formValues, lockMode: 'FLATTEN', stamp });
    const a = await renderDocument(input);
    const b = await renderDocument(input);
    expect(a.sha256).toBe(b.sha256);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    const c = await renderDocument({ ...input, values: { ...formValues, name: 'Priya Nair' } });
    expect(c.sha256).not.toBe(a.sha256);
  });

  it('maps characters the standard fonts cannot encode, and reports the rest', async () => {
    expect(toWinAnsi('José ₹500 Şahin')).toEqual({ text: 'José Rs.500 Sahin', replaced: [] });
    const r = toWinAnsi('नमस्ते Rahul');
    expect(r.text.endsWith(' Rahul')).toBe(true);
    expect(r.replaced.length).toBeGreaterThan(0);
    const out = await renderDocument(baseInput(await formPdf(), { fields: [formFields[0]!], values: { name: 'राहुल' } }));
    expect(out.warnings.join(' ')).toContain('replaced');
  });

  it('layout helpers shrink, truncate and wrap', async () => {
    const doc = await PDFDocument.create();
    const font = doc.embedStandardFont(StandardFonts.Helvetica);
    expect(fitSingleLine(font, 'Short', 11, 200)).toEqual({ text: 'Short', size: 11, truncated: false });
    expect(fitSingleLine(font, 'y'.repeat(200), 11, 50).truncated).toBe(true);
    expect(wrapLines(font, 'one two three four five six', 10, 50).length).toBeGreaterThan(1);
  });
});
