/**
 * §69 Automation condition engine.
 *
 * Conditions form an AND/OR tree evaluated against a record's data. This
 * module is pure and has no database or network access, which is what makes
 * it safe to run against thousands of records during the "how many would
 * this affect?" preview (§74) as well as on every record write.
 *
 * Shape:
 *   { op: 'AND' | 'OR', rules: [ Rule | Group ] }
 *   Rule: { field, operator, value? }
 */

export type ComparisonOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty';

export interface ConditionRule {
  field: string;
  operator: ComparisonOperator;
  value?: unknown;
}

export interface ConditionGroup {
  op: 'AND' | 'OR';
  rules: (ConditionRule | ConditionGroup)[];
}

export type Condition = ConditionRule | ConditionGroup;

export function isGroup(condition: Condition): condition is ConditionGroup {
  return typeof condition === 'object' && condition !== null && 'op' in condition && 'rules' in condition;
}

/** Normalizes for comparison: trims strings, treats null/undefined as ''. */
function normalize(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = normalize(value);
  if (text === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Loose equality that matches operator intuition: "1" equals 1, and "Yes"
 * equals true. Operations staff type values into a spreadsheet — a strict
 * type match would make `Trigger = 1` fail on the string "1" they typed,
 * which is the single most common condition in this product.
 */
function looseEquals(a: unknown, b: unknown): boolean {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na === nb;

  const sa = normalize(a).toLowerCase();
  const sb = normalize(b).toLowerCase();
  const truthy = new Set(['true', 'yes', '1', 'checked']);
  const falsy = new Set(['false', 'no', '0', 'unchecked', '']);
  if (truthy.has(sa) && truthy.has(sb)) return true;
  if (falsy.has(sa) && falsy.has(sb)) return true;

  return sa === sb;
}

export function evaluateRule(rule: ConditionRule, data: Record<string, unknown>): boolean {
  const actual = data[rule.field];

  switch (rule.operator) {
    case 'equals':
      return looseEquals(actual, rule.value);
    case 'not_equals':
      return !looseEquals(actual, rule.value);
    case 'contains':
      return normalize(actual).toLowerCase().includes(normalize(rule.value).toLowerCase());
    case 'not_contains':
      return !normalize(actual).toLowerCase().includes(normalize(rule.value).toLowerCase());
    case 'greater_than': {
      const a = asNumber(actual);
      const b = asNumber(rule.value);
      // Non-numeric values fall back to lexicographic comparison so date
      // strings still order sensibly.
      if (a === null || b === null) return normalize(actual) > normalize(rule.value);
      return a > b;
    }
    case 'less_than': {
      const a = asNumber(actual);
      const b = asNumber(rule.value);
      if (a === null || b === null) return normalize(actual) < normalize(rule.value);
      return a < b;
    }
    case 'is_empty':
      return normalize(actual) === '';
    case 'is_not_empty':
      return normalize(actual) !== '';
    default:
      // An unknown operator must never silently pass — that would send mail
      // to people the condition was meant to exclude.
      return false;
  }
}

export function evaluateCondition(condition: Condition, data: Record<string, unknown>): boolean {
  if (!isGroup(condition)) return evaluateRule(condition, data);

  // An empty group matches everything. That is intentional: an automation
  // with no conditions targets the whole dataset, and §74 forces an explicit
  // confirmation showing exactly how many records that is.
  if (condition.rules.length === 0) return true;

  return condition.op === 'AND'
    ? condition.rules.every((rule) => evaluateCondition(rule, data))
    : condition.rules.some((rule) => evaluateCondition(rule, data));
}

const OPERATOR_LABELS: Record<ComparisonOperator, string> = {
  equals: '=',
  not_equals: '≠',
  contains: 'contains',
  not_contains: 'does not contain',
  greater_than: '>',
  less_than: '<',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};

/** Human-readable text for audit trails and "why was this sent" (§35/§72). */
export function describeCondition(condition: Condition): string {
  if (!isGroup(condition)) {
    const label = OPERATOR_LABELS[condition.operator] ?? condition.operator;
    if (condition.operator === 'is_empty' || condition.operator === 'is_not_empty') {
      return `${condition.field} ${label}`;
    }
    return `${condition.field} ${label} ${normalize(condition.value)}`;
  }
  if (condition.rules.length === 0) return 'all records';
  const parts = condition.rules.map((rule) => {
    const text = describeCondition(rule);
    return isGroup(rule) && rule.rules.length > 1 ? `(${text})` : text;
  });
  return parts.join(condition.op === 'AND' ? ' AND ' : ' OR ');
}

/** Collects every field a condition tree references, for validation. */
export function conditionFields(condition: Condition): string[] {
  if (!isGroup(condition)) return [condition.field];
  return Array.from(new Set(condition.rules.flatMap(conditionFields)));
}
