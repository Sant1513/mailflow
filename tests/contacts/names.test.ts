import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
const { cleanName, pickNameColumn } = await import('@/lib/contacts/names');

describe('contact names', () => {
  it('picks the person-name column, never Username', () => {
    const cols = [
      { key: 'username', label: 'Username', type: 'TEXT' },
      { key: 'name', label: 'name', type: 'TEXT' },
      { key: 'email', label: 'Email', type: 'EMAIL' },
    ];
    expect(pickNameColumn(cols)?.key).toBe('name');
    expect(pickNameColumn([{ key: 'student_name', label: 'Student Name', type: 'TEXT' }])?.key).toBe('student_name');
    expect(pickNameColumn([{ key: 'col_3', label: 'Full name', type: 'TEXT' }])?.key).toBe('col_3');
    expect(pickNameColumn([{ key: 'username', label: 'Username', type: 'TEXT' }, { key: 'company_name', label: 'Company name', type: 'TEXT' }])).toBeNull();
    expect(pickNameColumn([{ key: 'name', label: 'Name', type: 'NUMBER' }])).toBeNull();
  });

  it('keeps only usable names', () => {
    expect(cleanName('  "Bhuvan  C"  ')).toBe('Bhuvan C');
    expect(cleanName('cbhuvan08@gmail.com')).toBeNull();
    expect(cleanName('N/A')).toBeNull();
    expect(cleanName('-')).toBeNull();
    expect(cleanName(42)).toBeNull();
    expect(cleanName('A')).toBeNull();
  });
});
