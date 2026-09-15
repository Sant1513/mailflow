import { describe, it, expect } from 'vitest';
import { checkDocumentConfig } from '@/lib/documents/checks';
import { documentFieldSchema, type DocumentFieldInput, type DocumentInspection } from '@/lib/documents/types';
import { clampBox, moveBox, resizeBox, boxAtPoint, nextFieldId } from '@/lib/documents/geometry';
import { documentReference } from '@/lib/documents/reference';

const inspection: DocumentInspection = {
  pageCount: 2,
  pages: [
    { width: 612, height: 792, rotation: 0 },
    { width: 792, height: 612, rotation: 90 },
  ],
  formFields: [
    { name: 'student_name', type: 'text', page: 0, rect: null },
    { name: 'batch', type: 'dropdown', page: 0, rect: null, options: ['FT-WEB-12', 'FT-WEB-13'] },
    { name: 'sign_here', type: 'signature', page: 0, rect: null },
  ],
  hasXfa: false,
};

const field = (over: Partial<DocumentFieldInput> & { id: string }) =>
  documentFieldSchema.parse({ label: `Field ${over.id}`, value: '{{Name}}', target: { kind: 'form', fieldName: 'student_name' }, ...over });

const config = (fields: ReturnType<typeof field>[], fileNamePattern = 'Agreement - {{Name}}.pdf') => ({ fields, fileNamePattern });

describe('checkDocumentConfig', () => {
  it('accepts a correct configuration', () => {
    const issues = checkDocumentConfig(
      config([field({ id: 'a' }), field({ id: 'b', value: 'Ref {{DocumentId}}', target: { kind: 'text', page: 0, x: 10, y: 10, width: 100, height: 20 } })]),
      inspection,
      ['Name', 'Email']
    );
    expect(issues).toEqual([]);
  });

  it('flags form fields that are missing or cannot be filled', () => {
    const issues = checkDocumentConfig(
      config([field({ id: 'a', target: { kind: 'form', fieldName: 'nope' } }), field({ id: 'b', target: { kind: 'form', fieldName: 'sign_here' } })]),
      inspection
    );
    expect(issues.map((i) => i.level)).toEqual(['error', 'error']);
    expect(issues[0]?.message).toContain('not in this PDF');
    expect(issues[1]?.message).toContain('signature');
  });

  it('flags a fixed dropdown value that is not an option, and double-mapped fields', () => {
    const issues = checkDocumentConfig(
      config([
        field({ id: 'a', value: 'FT-DATA-1', target: { kind: 'form', fieldName: 'batch' } }),
        field({ id: 'b', value: 'ft-web-12', target: { kind: 'form', fieldName: 'batch' } }),
      ]),
      inspection
    );
    expect(issues.find((i) => i.fieldId === 'a')?.message).toContain('not one of the options');
    expect(issues.find((i) => i.fieldId === 'b')?.level).toBe('warning');
  });

  it('flags text boxes off the page, on missing pages and on rotated pages', () => {
    const issues = checkDocumentConfig(
      config([
        field({ id: 'a', target: { kind: 'text', page: 0, x: 600, y: 10, width: 100, height: 20 } }),
        field({ id: 'b', target: { kind: 'text', page: 5, x: 0, y: 0, width: 100, height: 20 } }),
        field({ id: 'c', target: { kind: 'text', page: 1, x: 0, y: 0, width: 100, height: 20 } }),
      ]),
      inspection
    );
    expect(issues.find((i) => i.fieldId === 'a')?.level).toBe('warning');
    expect(issues.find((i) => i.fieldId === 'b')?.message).toContain('page 6');
    expect(issues.find((i) => i.fieldId === 'c')?.message).toContain('rotated');
  });

  it('flags variables the dataset does not have, but allows system variables', () => {
    const issues = checkDocumentConfig(config([field({ id: 'a', value: '{{Batch}} {{Today}}' })], '{{Cohort}}.pdf'), inspection, ['Name']);
    expect(issues.map((i) => i.message)).toEqual([
      '"Field a" uses {{Batch}}, which the dataset does not have.',
      'The file name uses {{Cohort}}, which the dataset does not have.',
    ]);
  });

  it('warns about XFA forms and empty values', () => {
    const issues = checkDocumentConfig(config([field({ id: 'a', value: '' })]), { ...inspection, hasXfa: true });
    expect(issues.map((i) => i.level)).toEqual(['warning', 'warning']);
  });
});

describe('editor geometry', () => {
  const page = { width: 600, height: 800 };

  it('keeps boxes on the page with a minimum size', () => {
    expect(clampBox({ x: -10, y: 790, width: 2, height: 50 }, page)).toEqual({ x: 0, y: 750, width: 8, height: 50 });
  });

  it('moves by screen pixels converted to points', () => {
    expect(moveBox({ x: 100, y: 100, width: 50, height: 20 }, 30, -15, 1.5, page)).toEqual({ x: 120, y: 90, width: 50, height: 20 });
  });

  it('resizes from the corner without crossing the page edge', () => {
    expect(resizeBox({ x: 550, y: 10, width: 40, height: 20 }, 100, -100, 1, page)).toEqual({ x: 550, y: 10, width: 50, height: 8 });
  });

  it('centres a new box on the clicked point', () => {
    expect(boxAtPoint(300, 400, page)).toEqual({ x: 210, y: 390, width: 180, height: 20 });
    expect(boxAtPoint(5, 5, page)).toEqual({ x: 0, y: 0, width: 180, height: 20 });
  });

  it('generates unused field ids', () => {
    expect(nextFieldId(['f1', 'f3'])).toBe('f4');
    expect(nextFieldId(['f2'])).toBe('f3');
  });
});

describe('documentReference', () => {
  it('is short, readable, stable and distinct per seed', () => {
    const a = documentReference('job1:doc1');
    expect(a).toMatch(/^MF-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(documentReference('job1:doc1')).toBe(a);
    expect(documentReference('job2:doc1')).not.toBe(a);
  });
});
