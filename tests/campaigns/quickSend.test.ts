import { describe, expect, it } from 'vitest';
import { ColumnType } from '@prisma/client';
import { normalizePastedList } from '@/lib/quickSend/paste';
import { columnsFromTable, headerToKey, normalizeVariables, textToHtml } from '@/lib/quickSend/prepare';
import { extractVariables, renderTemplate } from '@/lib/templates/variables';

describe('pasted lists', () => {
  it('a plain list of addresses becomes an Email column', () => {
    expect(normalizePastedList('rahul@example.com\nneha@example.com\n')).toBe('Email\nrahul@example.com\nneha@example.com');
  });

  it('"Name, email" and "Name <email>" lines keep the name', () => {
    expect(normalizePastedList('Rahul Sharma, rahul@example.com\nNeha Singh <neha@example.com>')).toBe('Name,Email\nRahul Sharma,rahul@example.com\nNeha Singh,neha@example.com');
  });

  it('rows copied from a sheet (with a header row) are left alone', () => {
    const sheet = 'Name\tEmail\nRahul\trahul@example.com';
    expect(normalizePastedList(sheet)).toBe(sheet);
  });
});

describe('columns from a pasted / uploaded table', () => {
  const table = {
    headers: ['First Name', 'Mail ID', 'Company', 'First Name'],
    rows: [{ 'First Name': 'Rahul', 'Mail ID': 'rahul@example.com', Company: 'Acme' }],
  };

  it('makes safe, unique keys and keeps the header as the label', () => {
    expect(headerToKey('First Name', 0)).toBe('First_Name');
    expect(headerToKey('2026 batch', 3)).toBe('col_2026_batch');
    const cols = columnsFromTable(table);
    expect(cols.map((c) => c.key)).toEqual(['First_Name', 'Mail_ID', 'Company', 'First_Name_2']);
    expect(cols[0]!.label).toBe('First Name');
  });

  it('finds the email column by its contents when the name does not say "email"', () => {
    const cols = columnsFromTable(table);
    expect(cols.filter((c) => c.type === ColumnType.EMAIL).map((c) => c.header)).toEqual(['Mail ID']);
  });

  it('one bad address does not hide the email column', () => {
    const t = {
      headers: ['Student', 'Mail ID'],
      rows: [
        { Student: 'Asha', 'Mail ID': 'asha@example.com' },
        { Student: 'Bo', 'Mail ID': 'bo@example.com' },
        { Student: 'Cy', 'Mail ID': 'cy@example.com' },
        { Student: 'Dud', 'Mail ID': 'not-an-email' },
        { Student: 'Ed', 'Mail ID': 'ed@example.com' },
      ],
    };
    expect(columnsFromTable(t).find((c) => c.type === ColumnType.EMAIL)?.header).toBe('Mail ID');
    // Small lists too: 3 good of 4.
    expect(columnsFromTable({ headers: t.headers, rows: t.rows.slice(1) }).find((c) => c.type === ColumnType.EMAIL)?.header).toBe('Mail ID');
    // A column that is mostly not addresses is never picked.
    expect(columnsFromTable({ headers: ['Notes'], rows: [{ Notes: 'a@b.co' }, { Notes: 'call back' }, { Notes: 'n/a' }] }).some((c) => c.type === ColumnType.EMAIL)).toBe(false);
  });

  it('a chosen email column wins, and only one column is the email column', () => {
    const t = { headers: ['Personal', 'Work'], rows: [{ Personal: 'a@x.com', Work: 'b@y.com' }] };
    const cols = columnsFromTable(t, 'Work');
    expect(cols.map((c) => c.type)).toEqual([ColumnType.TEXT, ColumnType.EMAIL]);
  });
});

describe('personalisation', () => {
  const columns = [
    { key: 'First_Name', label: 'First Name', header: 'First Name' },
    { key: 'Company', label: 'Company' },
  ];

  it('{{First Name}}, {{first name}} and {{First_Name}} all become the column key', () => {
    expect(normalizeVariables('Hi {{First Name}}, {{ first name }} at {{company}} / {{First_Name}}', columns)).toBe(
      'Hi {{First_Name}}, {{First_Name}} at {{Company}} / {{First_Name}}',
    );
  });

  it('unknown fields are left as written so they show up as missing', () => {
    const out = normalizeVariables('Hi {{Nickname}}', columns);
    expect(out).toBe('Hi {{Nickname}}');
    expect(extractVariables(out)).toEqual(['Nickname']);
  });

  it('plain text becomes paragraphs and line breaks, with HTML escaped and fields kept', () => {
    const html = textToHtml('Hi {{First_Name}},\n\nYour offer <b>is</b> ready.\nSee you soon\n\nRegards');
    expect(html).toBe('<p>Hi {{First_Name}},</p>\n<p>Your offer &lt;b&gt;is&lt;/b&gt; ready.<br>See you soon</p>\n<p>Regards</p>');
    expect(renderTemplate({ subject: 's', html }, { First_Name: 'Rahul' }).html).toContain('<p>Hi Rahul,</p>');
  });
});
