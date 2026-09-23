import { describe, expect, it } from 'vitest';
import { effectiveAssignedFields, lockedFieldsOf, lockedKeysForSigner } from '@/lib/signing/fields';
import {
  hasSignatureTokens,
  renderSignatureTokensHtml,
  signatureToken,
} from '@/lib/signing/signature-tokens';
import { generateSignedPdf } from '@/lib/documents/pdf';

// Mirrors the uploaded CSV: parent_name / student_* columns present but blank.
const KEYS = ['parent_address', 'parent_name', 'student_id', 'student_name'];
const ROW = { parent_address: 'a 70 manohar', parent_name: '', student_id: '', student_name: '' };

describe('blank CSV cells are left for the signer', () => {
  it('locks only the values the sender provided (single signer)', () => {
    expect(lockedKeysForSigner(KEYS, ROW, [], false)).toEqual(['parent_address']);
  });

  it('gives unassigned blank fields to the first signer', () => {
    const [first, second] = effectiveAssignedFields(KEYS, ROW, [[], ['student_id']]);
    expect(first).toEqual(['parent_name', 'student_name']);
    expect(second).toEqual(['student_id']);
  });

  it('locks other signers\' blank fields so each blank has one owner', () => {
    const assignments = effectiveAssignedFields(KEYS, ROW, [[], ['student_id']]);
    expect(lockedKeysForSigner(KEYS, ROW, assignments[0]!, true)).toEqual(['parent_address', 'student_id']);
    expect(lockedKeysForSigner(KEYS, ROW, assignments[1]!, true)).toEqual([
      'parent_address',
      'parent_name',
      'student_name',
    ]);
  });

  it('keeps single-signer assignments untouched', () => {
    expect(effectiveAssignedFields(KEYS, ROW, [['student_id']])).toEqual([['student_id']]);
  });

  it('reads the stored lock list and ignores junk', () => {
    expect(lockedFieldsOf({ a: '1', __lockedFields: ['a', 3, 'b'] })).toEqual(['a', 'b']);
    expect(lockedFieldsOf(null)).toEqual([]);
  });
});

describe('signature placement tokens', () => {
  it('builds compact tokens', () => {
    expect(signatureToken(1, 'left')).toBe('[[signature]]');
    expect(signatureToken(2, 'right')).toBe('[[signature:2:right]]');
    expect(signatureToken(3, 'left')).toBe('[[signature:3]]');
  });

  it('detects tokens without treating them as CSV variables', () => {
    expect(hasSignatureTokens('<p>Hi</p><p>[[signature:2:center]]</p>')).toBe(true);
    expect(hasSignatureTokens('<p>{{signature}}</p>')).toBe(false);
  });

  it('renders each slot with its alignment and escapes names', () => {
    const html = renderSignatureTokensHtml('<p>[[signature:2:right]]</p>', [
      { signerIndex: 2, role: 'Parent', name: '<Amit>' },
    ]);
    expect(html).toContain('data-signature-slot="2"');
    expect(html).toContain('text-align:right');
    expect(html).toContain('Parent signs here');
    expect(html).toContain('&lt;Amit&gt;');
    expect(html).not.toContain('<Amit>');
  });
});

describe('PDF rendering with inline signatures', () => {
  // 1x1 transparent PNG
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('renders a document with signature tokens', async () => {
    const pdf = await generateSignedPdf({
      title: 'PAP Extension',
      content: '<p>Parent: {{parent_name}}</p><p>[[signature]]</p><p>Witness</p><p>[[signature:2:right]]</p>',
      recipientName: 'Rahul',
      recipientEmail: 'rahul@example.com',
      fieldValues: { parent_name: 'Amit' },
      signatureImage: PNG,
      signedAt: new Date('2026-09-23T10:00:00Z'),
      signerIp: '127.0.0.1',
      signatureSlots: [{ signerIndex: 1, role: 'Student', name: 'Rahul', image: PNG, signedAt: new Date() }],
    });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('renders an unsigned preview with bracketed blanks', async () => {
    const pdf = await generateSignedPdf({
      title: 'Preview',
      content: '<p>{{student_name}}</p><p>[[signature:center]]</p>',
      recipientName: 'Rahul',
      recipientEmail: '',
      fieldValues: {},
      signatureImage: '',
      signedAt: new Date(),
      signerIp: '',
      preview: true,
      signatureSlots: [{ signerIndex: 1, role: 'Student' }],
    });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
