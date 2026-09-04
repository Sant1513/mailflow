import { describe, it, expect } from 'vitest';
import {
  evaluateRule,
  evaluateCondition,
  describeCondition,
  conditionFields,
  type Condition,
} from '@/lib/automation/conditions';

const record = {
  Name: 'Rahul Sharma',
  Email: 'rahul@example.com',
  Status: 'Pending',
  Trigger: '1',
  Score: 72,
  Notes: '',
  Cleared: false,
};

describe('evaluateRule — equals / not_equals', () => {
  it('matches an exact string', () => {
    expect(evaluateRule({ field: 'Status', operator: 'equals', value: 'Pending' }, record)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(evaluateRule({ field: 'Status', operator: 'equals', value: 'pending' }, record)).toBe(true);
  });

  it('matches the string "1" against the number 1 — the most common real condition', () => {
    expect(evaluateRule({ field: 'Trigger', operator: 'equals', value: 1 }, record)).toBe(true);
    expect(evaluateRule({ field: 'Trigger', operator: 'equals', value: '1' }, record)).toBe(true);
  });

  it('treats yes/true/1 as equivalent truthy values', () => {
    expect(evaluateRule({ field: 'Trigger', operator: 'equals', value: 'yes' }, record)).toBe(true);
    expect(evaluateRule({ field: 'Trigger', operator: 'equals', value: true }, record)).toBe(true);
  });

  it('treats no/false/0/empty as equivalent falsy values', () => {
    expect(evaluateRule({ field: 'Cleared', operator: 'equals', value: 'no' }, record)).toBe(true);
    expect(evaluateRule({ field: 'Cleared', operator: 'equals', value: 0 }, record)).toBe(true);
  });

  it('not_equals is the inverse', () => {
    expect(evaluateRule({ field: 'Status', operator: 'not_equals', value: 'Completed' }, record)).toBe(true);
    expect(evaluateRule({ field: 'Status', operator: 'not_equals', value: 'Pending' }, record)).toBe(false);
  });

  it('does not match a missing field against a non-empty value', () => {
    expect(evaluateRule({ field: 'Nope', operator: 'equals', value: 'x' }, record)).toBe(false);
  });
});

describe('evaluateRule — contains', () => {
  it('matches a substring case-insensitively', () => {
    expect(evaluateRule({ field: 'Name', operator: 'contains', value: 'sharma' }, record)).toBe(true);
  });

  it('not_contains is the inverse', () => {
    expect(evaluateRule({ field: 'Name', operator: 'not_contains', value: 'Gupta' }, record)).toBe(true);
  });
});

describe('evaluateRule — comparisons', () => {
  it('compares numbers numerically, not lexicographically', () => {
    // "9" > "72" lexicographically, but 9 > 72 is false.
    expect(evaluateRule({ field: 'Score', operator: 'greater_than', value: 9 }, record)).toBe(true);
    expect(evaluateRule({ field: 'Score', operator: 'less_than', value: 9 }, record)).toBe(false);
  });

  it('handles numeric strings', () => {
    expect(evaluateRule({ field: 'Trigger', operator: 'greater_than', value: 0 }, record)).toBe(true);
  });

  it('falls back to string comparison for dates', () => {
    const dated = { Deadline: '2026-04-16' };
    expect(evaluateRule({ field: 'Deadline', operator: 'greater_than', value: '2026-01-01' }, dated)).toBe(true);
    expect(evaluateRule({ field: 'Deadline', operator: 'less_than', value: '2026-01-01' }, dated)).toBe(false);
  });
});

describe('evaluateRule — emptiness', () => {
  it('treats an empty string as empty', () => {
    expect(evaluateRule({ field: 'Notes', operator: 'is_empty' }, record)).toBe(true);
  });

  it('treats a missing field as empty', () => {
    expect(evaluateRule({ field: 'Absent', operator: 'is_empty' }, record)).toBe(true);
  });

  it('treats whitespace as empty', () => {
    expect(evaluateRule({ field: 'W', operator: 'is_empty' }, { W: '   ' })).toBe(true);
  });

  it('is_not_empty is the inverse', () => {
    expect(evaluateRule({ field: 'Name', operator: 'is_not_empty' }, record)).toBe(true);
    expect(evaluateRule({ field: 'Notes', operator: 'is_not_empty' }, record)).toBe(false);
  });
});

describe('evaluateRule — safety', () => {
  it('returns false for an unknown operator rather than passing', () => {
    // Failing open here would email people the condition meant to exclude.
    expect(evaluateRule({ field: 'Status', operator: 'wat' as any, value: 'x' }, record)).toBe(false);
  });
});

describe('evaluateCondition — AND/OR trees', () => {
  it('AND requires every rule', () => {
    const condition: Condition = {
      op: 'AND',
      rules: [
        { field: 'Trigger', operator: 'equals', value: 1 },
        { field: 'Status', operator: 'equals', value: 'Pending' },
      ],
    };
    expect(evaluateCondition(condition, record)).toBe(true);
    expect(evaluateCondition(condition, { ...record, Status: 'Completed' })).toBe(false);
  });

  it('OR requires only one rule', () => {
    const condition: Condition = {
      op: 'OR',
      rules: [
        { field: 'Status', operator: 'equals', value: 'Completed' },
        { field: 'Trigger', operator: 'equals', value: 1 },
      ],
    };
    expect(evaluateCondition(condition, record)).toBe(true);
  });

  it('supports nested groups', () => {
    const condition: Condition = {
      op: 'AND',
      rules: [
        { field: 'Trigger', operator: 'equals', value: 1 },
        {
          op: 'OR',
          rules: [
            { field: 'Status', operator: 'equals', value: 'Pending' },
            { field: 'Status', operator: 'equals', value: 'In Review' },
          ],
        },
      ],
    };
    expect(evaluateCondition(condition, record)).toBe(true);
    expect(evaluateCondition(condition, { ...record, Status: 'Completed' })).toBe(false);
  });

  it('an empty group matches everything (targets the whole dataset)', () => {
    expect(evaluateCondition({ op: 'AND', rules: [] }, record)).toBe(true);
  });
});

describe('describeCondition', () => {
  it('renders a single rule readably', () => {
    expect(describeCondition({ field: 'Trigger', operator: 'equals', value: 1 })).toBe('Trigger = 1');
  });

  it('renders emptiness rules without a value', () => {
    expect(describeCondition({ field: 'Notes', operator: 'is_empty' })).toBe('Notes is empty');
  });

  it('joins AND groups', () => {
    expect(
      describeCondition({
        op: 'AND',
        rules: [
          { field: 'Trigger', operator: 'equals', value: 1 },
          { field: 'Status', operator: 'equals', value: 'Pending' },
        ],
      })
    ).toBe('Trigger = 1 AND Status = Pending');
  });

  it('parenthesizes nested groups', () => {
    const text = describeCondition({
      op: 'AND',
      rules: [
        { field: 'Trigger', operator: 'equals', value: 1 },
        {
          op: 'OR',
          rules: [
            { field: 'Status', operator: 'equals', value: 'A' },
            { field: 'Status', operator: 'equals', value: 'B' },
          ],
        },
      ],
    });
    expect(text).toBe('Trigger = 1 AND (Status = A OR Status = B)');
  });

  it('describes an empty group as "all records"', () => {
    expect(describeCondition({ op: 'AND', rules: [] })).toBe('all records');
  });
});

describe('conditionFields', () => {
  it('collects every referenced field, de-duplicated', () => {
    const fields = conditionFields({
      op: 'AND',
      rules: [
        { field: 'Trigger', operator: 'equals', value: 1 },
        { op: 'OR', rules: [{ field: 'Status', operator: 'equals', value: 'A' }, { field: 'Trigger', operator: 'is_not_empty' }] },
      ],
    });
    expect(fields.sort()).toEqual(['Status', 'Trigger']);
  });
});
