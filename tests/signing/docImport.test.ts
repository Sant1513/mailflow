import { describe, expect, it } from 'vitest';
import { cleanImportedPlaceholders, googleDocId, humanizeKey } from '@/lib/signing/docImport';

describe('cleanImportedPlaceholders', () => {
  it('keeps clean placeholders and lists them once', () => {
    const r = cleanImportedPlaceholders('<p>Dear {{student_name}}, stipend {{ stipend }}. Bye {{student_name}}</p>');
    expect(r.html).toBe('<p>Dear {{student_name}}, stipend {{stipend}}. Bye {{student_name}}</p>');
    expect(r.fields).toEqual([
      { key: 'student_name', label: 'Student name' },
      { key: 'stipend', label: 'Stipend' },
    ]);
  });

  it('rejoins a placeholder Word split across formatting runs', () => {
    const r = cleanImportedPlaceholders('<p>{{<strong>student</strong>_name}}</p>');
    expect(r.html).toBe('<p><strong>{{student_name}}</strong></p>');
    expect(r.fields.map((f) => f.key)).toEqual(['student_name']);
  });

  it('rejoins braces split into separate runs', () => {
    const r = cleanImportedPlaceholders('<p>{<span>{</span>company}}</p>');
    expect(r.fields.map((f) => f.key)).toEqual(['company']);
    expect(r.html).toContain('{{company}}');
  });

  it('keeps tag pairs balanced when a tag opens inside and closes outside', () => {
    expect(cleanImportedPlaceholders('<p>{{stu<em>dent}}</em></p>').html).toBe('<p>{{student}}<em></em></p>');
    expect(cleanImportedPlaceholders('<p><em>{{stu</em>dent}}</p>').html).toBe('<p><em></em>{{student}}</p>');
  });

  it('normalises spaced or mixed-case labels into keys', () => {
    const r = cleanImportedPlaceholders('<p>{{Joining Date}} {{1st Month}}</p>');
    expect(r.html).toBe('<p>{{joining_date}} {{field_1st_month}}</p>');
  });

  it('decodes entities inside braces', () => {
    const r = cleanImportedPlaceholders('<p>{{&nbsp;name&nbsp;}}</p>');
    expect(r.html).toBe('<p>{{name}}</p>');
  });

  it('puts split signature tokens back together and does not list them as fields', () => {
    const r = cleanImportedPlaceholders('<p>[[sig<strong>nature:2</strong>]]</p>');
    expect(r.html).toBe('<p>[[signature:2]]</p>');
    expect(r.fields).toEqual([]);
  });

  it('leaves other square-bracket text alone', () => {
    expect(cleanImportedPlaceholders('<p>[[not a token]]</p>').html).toBe('<p>[[not a token]]</p>');
  });
});

describe('googleDocId', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  it('reads the id from Docs links', () => {
    expect(googleDocId(`https://docs.google.com/document/d/${id}/edit?usp=sharing`)).toBe(id);
    expect(googleDocId(`https://docs.google.com/document/u/0/d/${id}/edit`)).toBe(id);
  });

  it('rejects other hosts, schemes and non-doc links', () => {
    expect(googleDocId(`http://docs.google.com/document/d/${id}/edit`)).toBeNull();
    expect(googleDocId(`https://evil.com/document/d/${id}`)).toBeNull();
    expect(googleDocId(`https://docs.google.com/spreadsheets/d/${id}`)).toBeNull();
    expect(googleDocId('not a url')).toBeNull();
  });
});

describe('humanizeKey', () => {
  it('turns keys into labels', () => {
    expect(humanizeKey('joining_date')).toBe('Joining date');
  });
});
