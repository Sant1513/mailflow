import { describe, it, expect } from 'vitest';
import {
  applyCase,
  formatDate,
  formatNumber,
  guessVariableForFormField,
  hasValue,
  isoDateInZone,
  isTruthy,
  parseDateValue,
  parseNumberValue,
  resolveField,
  resolveFileName,
  resolveText,
  sanitizeFileName,
  variablesIn,
} from '@/lib/documents/values';
import { documentFieldSchema, type DocumentFieldInput } from '@/lib/documents/types';

const field = (over: Partial<DocumentFieldInput> = {}) =>
  documentFieldSchema.parse({ id: 'f1', label: 'Name', value: '{{Name}}', target: { kind: 'form', fieldName: 'name' }, ...over });

describe('variablesIn', () => {
  it('lists unique variables in order of appearance', () => {
    expect(variablesIn('{{ First }} {{Last}} — {{First}}', 'Ref {{DocumentId}}')).toEqual(['First', 'Last', 'DocumentId']);
  });
});

describe('dates', () => {
  it('parses ISO, Indian day-first and written dates', () => {
    expect(parseDateValue('2026-09-15')).toEqual({ year: 2026, month: 9, day: 15 });
    expect(parseDateValue('2026-09-15T18:30:00.000Z')).toEqual({ year: 2026, month: 9, day: 15 });
    expect(parseDateValue('15/09/2026')).toEqual({ year: 2026, month: 9, day: 15 });
    expect(parseDateValue('5-9-2026')).toEqual({ year: 2026, month: 9, day: 5 });
    expect(parseDateValue('15 Sep 2026')).toEqual({ year: 2026, month: 9, day: 15 });
    expect(parseDateValue('15th September, 2026')).toEqual({ year: 2026, month: 9, day: 15 });
    expect(parseDateValue('Sept 15, 2026')).toEqual({ year: 2026, month: 9, day: 15 });
  });

  it('rejects impossible or non-dates', () => {
    expect(parseDateValue('31/02/2026')).toBeNull();
    expect(parseDateValue('13/13/2026')).toBeNull();
    expect(parseDateValue('next week')).toBeNull();
  });

  it('formats every supported pattern', () => {
    const d = { year: 2026, month: 9, day: 5 };
    expect(formatDate(d, 'D MMM YYYY')).toBe('5 Sep 2026');
    expect(formatDate(d, 'D MMMM YYYY')).toBe('5 September 2026');
    expect(formatDate(d, 'DD/MM/YYYY')).toBe('05/09/2026');
    expect(formatDate(d, 'YYYY-MM-DD')).toBe('2026-09-05');
    expect(formatDate(d, 'MMMM D, YYYY')).toBe('September 5, 2026');
  });

  it('computes today in the campaign time zone', () => {
    expect(isoDateInZone(new Date('2026-09-09T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-09-10');
  });
});

describe('numbers and case', () => {
  it('parses amounts with separators and currency prefixes', () => {
    expect(parseNumberValue('1,50,000')).toBe(150000);
    expect(parseNumberValue('Rs. 2,500.50')).toBe(2500.5);
    expect(parseNumberValue('₹ 99')).toBe(99);
    expect(parseNumberValue('about 5')).toBeNull();
  });

  it('formats Indian, international and rupee amounts', () => {
    expect(formatNumber(150000, 'indian')).toBe('1,50,000');
    expect(formatNumber(150000, 'international')).toBe('150,000');
    expect(formatNumber(150000, 'inr')).toBe('Rs. 1,50,000');
    expect(formatNumber(2500.5, 'inr')).toBe('Rs. 2,500.50');
  });

  it('applies case to the whole value', () => {
    expect(applyCase('rahul kumar-sharma', 'title')).toBe('Rahul Kumar-Sharma');
    expect(applyCase('Rahul', 'upper')).toBe('RAHUL');
  });
});

describe('resolveText', () => {
  const system = { Today: '2026-09-10', SenderName: 'Abhishesh', DocumentId: 'MF-ABCD1234' };

  it('substitutes data and system values with per-variable formats', () => {
    const r = resolveText('Joining {{JoiningDate}} · Ref {{DocumentId}}', { JoiningDate: '2026-10-01' }, system, { date: 'D MMMM YYYY' });
    expect(r).toEqual({ value: 'Joining 1 October 2026 · Ref MF-ABCD1234', missing: [], warnings: [] });
  });

  it('writes {{Today}} as a written date by default', () => {
    expect(resolveText('{{Today}}', {}, system).value).toBe('10 September 2026');
  });

  it('lets a dataset column named like a system variable win', () => {
    expect(resolveText('{{SenderName}}', { SenderName: 'Placement Cell' }, system).value).toBe('Placement Cell');
  });

  it('reports missing variables and tidies the gap they leave', () => {
    const r = resolveText('{{First}} {{Middle}} {{Last}}', { First: 'Rahul', Middle: '', Last: 'Sharma' }, system);
    expect(r.value).toBe('Rahul Sharma');
    expect(r.missing).toEqual(['Middle']);
  });

  it('warns instead of failing when a value is not in the requested format', () => {
    const r = resolveText('{{Start}}', { Start: 'TBD' }, system, { date: 'DD/MM/YYYY' });
    expect(r.value).toBe('TBD');
    expect(r.warnings[0]).toContain('not a recognisable date');
  });
});

describe('resolveField', () => {
  it('blocks a required field with a missing value', () => {
    const r = resolveField(field(), { Name: '  ' }, {});
    expect(r.blocking).toBe(true);
    expect(r.missing).toEqual(['Name']);
  });

  it('uses the fallback for an optional field', () => {
    const r = resolveField(field({ required: false, value: 'Batch {{Batch}}', fallback: 'Batch to be assigned' }), {}, {});
    expect(r).toMatchObject({ value: 'Batch to be assigned', usedFallback: true, blocking: false });
  });

  it('applies case to the fallback too', () => {
    const r = resolveField(field({ required: false, fallback: 'not provided', format: { case: 'upper' } }), {}, {});
    expect(r.value).toBe('NOT PROVIDED');
  });
});

describe('file names', () => {
  it('removes characters Windows and mail clients reject', () => {
    expect(sanitizeFileName('Offer Letter - Rahul/Sharma?.pdf')).toBe('Offer Letter - Rahul Sharma.pdf');
    expect(sanitizeFileName('A\u0007B')).toBe('A B.pdf');
  });

  it('drops dangling separators left by a missing name and falls back when empty', () => {
    expect(resolveFileName('Offer Letter - {{Name}}.pdf', {}, {}, 'Offer')).toBe('Offer Letter.pdf');
    expect(resolveFileName('{{Name}}', {}, {}, 'Agreement')).toBe('Agreement.pdf');
  });

  it('caps very long names', () => {
    expect(sanitizeFileName('x'.repeat(300)).length).toBe(124);
  });
});

describe('guessVariableForFormField', () => {
  const columns = ['Name', 'Email', 'Phone', 'BatchCode'];
  it('maps common PDF field names to columns', () => {
    expect(guessVariableForFormField('student_name', columns)).toBe('Name');
    expect(guessVariableForFormField('txtEmailAddress', columns)).toBe('Email');
    expect(guessVariableForFormField('Mobile No', columns)).toBe('Phone');
    expect(guessVariableForFormField('batch_code', columns)).toBe('BatchCode');
    expect(guessVariableForFormField('Date', [])).toBe('Today');
  });

  it('returns null rather than a weak guess', () => {
    expect(guessVariableForFormField('signature', columns)).toBeNull();
  });
});

describe('small helpers', () => {
  it('treats common yes-values as ticked', () => {
    expect(['Yes', 'TRUE', '1', 'x', '✓'].every(isTruthy)).toBe(true);
    expect(['No', '', '0', 'maybe'].some(isTruthy)).toBe(false);
  });

  it('knows whether a variable has a value', () => {
    expect(hasValue({ Name: 'Rahul' }, 'Name')).toBe(true);
    expect(hasValue({ Name: '' }, 'Name')).toBe(false);
    expect(hasValue({}, 'Today')).toBe(true);
    expect(hasValue({}, 'Batch')).toBe(false);
  });
});
