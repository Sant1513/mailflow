import { describe, it, expect } from 'vitest';
import {
  parsePastedText,
  inferColumnTypes,
  guessEmailColumn,
  analyzeDuplicates,
} from '@/lib/imports/parse';

describe('parsePastedText', () => {
  it('parses tab-separated pasted data with headers', () => {
    const text = 'Name\tEmail\tCode\nRahul Sharma\trahul@example.com\tfd41\nPriya Sharma\tpriya@example.com\tfd39';
    const table = parsePastedText(text);
    expect(table.headers).toEqual(['Name', 'Email', 'Code']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]?.Email).toBe('rahul@example.com');
  });

  it('falls back to comma delimiter when no tabs are present', () => {
    const text = 'Name,Email\nRahul,rahul@example.com';
    const table = parsePastedText(text);
    expect(table.headers).toEqual(['Name', 'Email']);
  });
});

describe('inferColumnTypes', () => {
  it('detects EMAIL and NUMBER columns', () => {
    const table = parsePastedText('Name\tEmail\tAge\nRahul\trahul@example.com\t21');
    const types = inferColumnTypes(table);
    expect(types.Email).toBe('EMAIL');
    expect(types.Age).toBe('NUMBER');
    expect(types.Name).toBe('TEXT');
  });
});

describe('guessEmailColumn', () => {
  it('prefers an exact "Email" header match', () => {
    expect(guessEmailColumn(['Name', 'Email', 'Contact Email'])).toBe('Email');
  });

  it('falls back to a header containing "email"', () => {
    expect(guessEmailColumn(['Name', 'Contact Email'])).toBe('Contact Email');
  });

  it('returns null when nothing matches', () => {
    expect(guessEmailColumn(['Name', 'Phone'])).toBeNull();
  });
});

describe('analyzeDuplicates', () => {
  it('counts duplicate rows by email, case-insensitively', () => {
    const table = parsePastedText(
      'Name\tEmail\nA\ta@example.com\nB\tA@example.com\nC\tc@example.com'
    );
    const result = analyzeDuplicates(table, 'Email');
    expect(result.uniqueEmails).toBe(2);
    expect(result.duplicateRows).toBe(1);
  });
});
