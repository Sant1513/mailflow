import { describe, expect, it } from 'vitest';
import {
  computeLockedFieldsForSigner,
  extractSigningVariables,
  groupSigningStatus,
  mergeGroupFieldValues,
  mergeSigningFieldDefs,
  normalizeBulkSigners,
  publicSigningFieldValues,
  renderSigningContent,
} from '@/lib/signing/fields';

describe('signing fields', () => {
  it('detects unique document variables from template content', () => {
    expect(
      extractSigningVariables('<p>{{student_name}} owes {{amount}}</p><p>{{ student_name }}</p>')
    ).toEqual(['student_name', 'amount']);
  });

  it('merges detected variables with existing field labels', () => {
    expect(
      mergeSigningFieldDefs('<p>{{student_name}} {{course_name}}</p>', [
        { key: 'student_name', label: 'Student full name', defaultValue: 'Rahul' },
      ])
    ).toEqual([
      { key: 'course_name', label: 'Course Name' },
      { key: 'student_name', label: 'Student full name', defaultValue: 'Rahul' },
    ]);
  });

  it('hides internal metadata from signer-visible values', () => {
    expect(
      publicSigningFieldValues({
        student_name: 'Rahul Sharma',
        __lockedFields: ['student_name'],
        __signerRole: 'Student',
      })
    ).toEqual({ student_name: 'Rahul Sharma' });
  });

  it('renders CSV-populated variables while escaping values', () => {
    expect(
      renderSigningContent('<p>{{student_name}}</p>', { student_name: '<Rahul>' })
    ).toBe('<p>&lt;Rahul&gt;</p>');
  });

  it('normalizes bulk signer configuration and caps at three signers', () => {
    expect(
      normalizeBulkSigners([
        { index: 1, role: 'Student', nameColumn: 'Student Name', emailColumn: 'Student Email' },
        { index: 2, role: 'Company', nameColumn: 'company_name', emailColumn: 'company_email' },
        { index: 3, role: 'Masai', nameColumn: 'masai_name', emailColumn: 'masai_email' },
        { index: 4, role: 'Ignored', nameColumn: 'ignored_name', emailColumn: 'ignored_email' },
      ])
    ).toEqual([
      { index: 1, role: 'Student', nameColumn: 'student_name', emailColumn: 'student_email', source: 'csv' },
      { index: 2, role: 'Company', nameColumn: 'company_name', emailColumn: 'company_email', source: 'csv' },
      { index: 3, role: 'Masai', nameColumn: 'masai_name', emailColumn: 'masai_email', source: 'csv' },
    ]);
  });

  it('keeps a fixed signer (same person every row) and cleans their details', () => {
    const [student, masai] = normalizeBulkSigners([
      { index: 1, role: ' Student ', nameColumn: 'Signer 1 Name', emailColumn: 'signer_1_email', source: 'fixed', fixedEmail: 'x@y.com' },
      { index: 2, role: 'MasaiSign', nameColumn: 'signer_2_name', emailColumn: 'signer_2_email', source: 'fixed', fixedName: ' Jisshnu N S ', fixedEmail: ' Jisshnu.NS@MasaiSchool.com ' },
    ]);
    // Signer 1 is always the row's recipient, so "fixed" is ignored for them.
    expect(student).toEqual({ index: 1, role: 'Student', nameColumn: 'signer_1_name', emailColumn: 'signer_1_email', source: 'csv' });
    expect(masai).toMatchObject({ source: 'fixed', fixedName: 'Jisshnu N S', fixedEmail: 'jisshnu.ns@masaischool.com' });
  });
});

describe('multi-signer helpers', () => {
  it('computes locked fields for a signer with assigned fields', () => {
    const all = ['student_name', 'company_name', 'course_name', 'start_date'];
    expect(computeLockedFieldsForSigner(all, ['student_name', 'course_name'])).toEqual([
      'company_name',
      'start_date',
    ]);
  });

  it('locks all fields when no specific assignment is given', () => {
    const all = ['student_name', 'company_name'];
    expect(computeLockedFieldsForSigner(all, [])).toEqual(all);
  });

  it('merges group field values only for assigned fields', () => {
    const existing = { student_name: 'Rahul', company_name: '', course_name: 'FSD' };
    const signerValues = { company_name: 'ABC Tech', course_name: 'Attempt to overwrite' };
    const assigned = ['company_name'];
    expect(mergeGroupFieldValues(existing, signerValues, assigned)).toEqual({
      student_name: 'Rahul',
      company_name: 'ABC Tech',
      course_name: 'FSD',
    });
  });

  it('tracks group signing progress correctly', () => {
    expect(groupSigningStatus(3, 0)).toBe('PENDING');
    expect(groupSigningStatus(3, 1)).toBe('IN_PROGRESS');
    expect(groupSigningStatus(3, 2)).toBe('IN_PROGRESS');
    expect(groupSigningStatus(3, 3)).toBe('COMPLETED');
  });
});
