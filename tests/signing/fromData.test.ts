import { describe, expect, it } from 'vitest';
import {
  CONTACT_EMAIL_KEY,
  CONTACT_NAME_KEY,
  autoMapData,
  cellText,
  detectEmailColumn,
  detectNameColumn,
  matchColumn,
  type SourceColumn,
  type SourceRow,
} from '@/lib/signing/fromData';

const columns: SourceColumn[] = [
  { key: 'student_name', label: 'Student Name' },
  { key: 'personal_email', label: 'Personal Email' },
  { key: 'manager_email', label: 'Manager Email' },
  { key: 'company_name', label: 'Company Name' },
  { key: 'stipend', label: 'Monthly Stipend' },
  { key: 'joiningdate', label: 'Joining Date' },
  { key: 'signing_status', label: 'Signing status' },
];

const row = (data: Record<string, string>): SourceRow => ({ recordId: 'r', datasetId: 'd', data });

const rows = [
  row({ student_name: 'Rahul Sharma', personal_email: 'rahul@example.com', manager_email: 'hr@acme.com', company_name: 'Acme', stipend: '15000', joiningdate: '01-10-2026' }),
  row({ student_name: 'Neha Singh', personal_email: 'neha@example.com', manager_email: 'hr@acme.com', company_name: 'Acme', stipend: '18000', joiningdate: '' }),
];

describe('matchColumn', () => {
  it('matches by key or label, exact first', () => {
    expect(matchColumn('stipend', columns)).toBe('stipend');
    expect(matchColumn('Monthly Stipend', columns)).toBe('stipend');
    expect(matchColumn('company_name', columns)).toBe('company_name');
  });

  it('matches ignoring separators', () => {
    expect(matchColumn('joining_date', columns)).toBe('joiningdate');
  });

  it('never offers MailFlow write-back columns as document values', () => {
    expect(matchColumn('signing_status', columns)).toBe('');
  });

  it('returns empty when nothing fits', () => {
    expect(matchColumn('offer_ctc', columns)).toBe('');
  });
});

describe('signer detection', () => {
  it('prefers the personal email column over a manager email', () => {
    expect(detectEmailColumn(columns, rows)).toBe('personal_email');
  });

  it('picks the full name column, not company name', () => {
    expect(detectNameColumn(columns, rows, 'personal_email')).toBe('student_name');
  });

  it('ignores a column named email whose values are not emails', () => {
    const cols = [{ key: 'email_sent', label: 'Email sent' }, { key: 'mail', label: 'Mail' }];
    const r = [row({ email_sent: 'Yes', mail: 'a@b.co' })];
    expect(detectEmailColumn(cols, r)).toBe('mail');
  });

  it('falls back to the contact columns for segment rows', () => {
    const cols = [{ key: CONTACT_NAME_KEY, label: 'Contact name' }, { key: CONTACT_EMAIL_KEY, label: 'Contact email' }];
    const r = [row({ [CONTACT_NAME_KEY]: 'Amit', [CONTACT_EMAIL_KEY]: 'amit@x.com' })];
    expect(detectEmailColumn(cols, r)).toBe(CONTACT_EMAIL_KEY);
    expect(detectNameColumn(cols, r, CONTACT_EMAIL_KEY)).toBe(CONTACT_NAME_KEY);
  });
});

describe('autoMapData', () => {
  it('maps template fields and extra signers by name', () => {
    const m = autoMapData({ columns, rows }, ['student_name', 'stipend', 'joining_date', 'offer_ctc'], [
      { index: 2, nameColumn: 'manager_name', emailColumn: 'manager_email' },
    ]);
    expect(m.nameColumn).toBe('student_name');
    expect(m.emailColumn).toBe('personal_email');
    expect(m.fields).toEqual({ student_name: 'student_name', stipend: 'stipend', joining_date: 'joiningdate', offer_ctc: '' });
    expect(m.signers[2]).toEqual({ nameColumn: '', emailColumn: 'manager_email' });
  });

  it('fills {{name}} and {{email}} from the signer columns', () => {
    const m = autoMapData({ columns, rows }, ['name', 'email'], []);
    expect(m.fields).toEqual({ name: 'student_name', email: 'personal_email' });
  });
});

describe('cellText', () => {
  it('formats stored values for a document', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(true)).toBe('Yes');
    expect(cellText(['a', 'b'])).toBe('a, b');
    expect(cellText(15000)).toBe('15000');
    expect(cellText('2026-10-01')).toBe('01-10-2026');
    expect(cellText('2026-10-01T00:00:00.000Z')).toBe('01-10-2026');
    expect(cellText('  Acme  ')).toBe('Acme');
  });
});
