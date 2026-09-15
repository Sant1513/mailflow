import type { CaseFormat, DateFormat, DocumentField, NumberFormat } from './types';

/**
 * Value resolution for personalised documents. Pure and isomorphic.
 *
 * A field's value is text with {{Variables}}. Variables come from the
 * recipient's dataset row first, then from a small set of system values.
 * Formatting (dates, numbers) applies per substituted variable; case applies
 * to the whole resolved field.
 */

const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export const SYSTEM_VARIABLES = ['Today', 'SenderName', 'SenderEmail', 'CampaignName', 'RecipientEmail', 'DocumentId'] as const;
export type SystemVariable = (typeof SYSTEM_VARIABLES)[number];
export type SystemValues = Partial<Record<SystemVariable, string>>;

export const SYSTEM_VARIABLE_HELP: Record<SystemVariable, string> = {
  Today: 'Date the email is queued (campaign time zone)',
  SenderName: 'Name the email is sent from',
  SenderEmail: 'Mailbox the email is sent from',
  CampaignName: 'Name of the campaign',
  RecipientEmail: "The student's email address",
  DocumentId: 'Unique reference of this copy, e.g. MF-7K2Q9PX4',
};

export function isSystemVariable(name: string): name is SystemVariable {
  return (SYSTEM_VARIABLES as readonly string[]).includes(name);
}

/** Unique variable names in order of first appearance. */
export function variablesIn(...sources: (string | null | undefined)[]): string[] {
  const seen: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(VARIABLE_RE)) {
      const name = match[1];
      if (name && !seen.includes(name)) seen.push(name);
    }
  }
  return seen;
}

export function stringifyValue(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(stringifyValue).filter(Boolean).join(', ');
  if (typeof value === 'object') return '';
  return String(value);
}

/** True when a variable would resolve to something for this row (system values always do). */
export function hasValue(data: Record<string, unknown>, name: string): boolean {
  if (Object.prototype.hasOwnProperty.call(data, name)) return stringifyValue(data[name]).trim() !== '';
  return isSystemVariable(name);
}

// ── Dates ────────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

function monthFromName(name: string): number | null {
  const lower = name.toLowerCase();
  if (lower.length < 3) return null;
  const index = MONTHS.findIndex((m) => m.toLowerCase().startsWith(lower));
  return index >= 0 ? index + 1 : null;
}

function validDate(year: number, month: number, day: number): DateParts | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth ? { year, month, day } : null;
}

/**
 * Accepts ISO (2026-09-15, optionally with a time), Indian day-first numeric
 * dates (15/09/2026, 15-09-2026, 15.09.2026) and written months
 * (15 Sep 2026, 15th September 2026, Sep 15, 2026). Date-only: no time zone
 * shifting, the calendar date written is the date printed.
 */
export function parseDateValue(raw: string): DateParts | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return validDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})$/.exec(s);
  if (m) {
    const month = monthFromName(m[2] ?? '');
    if (month) return validDate(Number(m[3]), month, Number(m[1]));
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = monthFromName(m[1] ?? '');
    if (month) return validDate(Number(m[3]), month, Number(m[2]));
  }
  return null;
}

export function formatDate(parts: DateParts, pattern: DateFormat): string {
  const monthName = MONTHS[parts.month - 1] ?? '';
  return pattern.replace(/YYYY|MMMM|MMM|MM|DD|D/g, (token) => {
    switch (token) {
      case 'YYYY':
        return String(parts.year);
      case 'MMMM':
        return monthName;
      case 'MMM':
        return monthName.slice(0, 3);
      case 'MM':
        return String(parts.month).padStart(2, '0');
      case 'DD':
        return String(parts.day).padStart(2, '0');
      default:
        return String(parts.day);
    }
  });
}

/** YYYY-MM-DD for "now" in a time zone (e.g. Asia/Kolkata). */
export function isoDateInZone(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// ── Numbers ──────────────────────────────────────────────────────────────

export function parseNumberValue(raw: string): number | null {
  const s = raw
    .trim()
    .replace(/^(rs\.?|inr|₹)\s*/i, '')
    .replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function formatNumber(n: number, format: NumberFormat): string {
  switch (format) {
    case 'indian':
      return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    case 'international':
      return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    case 'inr':
      return `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
}

export function applyCase(text: string, format: CaseFormat): string {
  switch (format) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'title':
      return text.toLowerCase().replace(/(^|[\s\-'(/])([a-z])/g, (_m, before: string, letter: string) => before + letter.toUpperCase());
  }
}

// ── Resolution ───────────────────────────────────────────────────────────

export interface ResolvedText {
  value: string;
  /** Variables with no value for this row. */
  missing: string[];
  warnings: string[];
}

export function resolveText(
  template: string,
  data: Record<string, unknown>,
  system: SystemValues,
  format: DocumentField['format'] = {}
): ResolvedText {
  const missing: string[] = [];
  const warnings: string[] = [];

  // A format applies to the variables that fit it: in "Joining {{Date}} · Ref
  // {{DocumentId}}" only the date is formatted. Warn only when a format was
  // requested and no variable in the field could take it.
  let formatted = false;
  const notDates: string[] = [];
  const notNumbers: string[] = [];

  const substituted = template.replace(VARIABLE_RE, (_full, name: string) => {
    const fromData = Object.prototype.hasOwnProperty.call(data, name);
    const raw = (fromData ? stringifyValue(data[name]) : isSystemVariable(name) ? system[name] ?? '' : '').trim();
    if (raw === '') {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }

    // {{Today}} reads as a written date unless the field asks for another format.
    if (format.date || (!fromData && name === 'Today')) {
      const parts = parseDateValue(raw);
      if (parts) {
        if (format.date) formatted = true;
        return formatDate(parts, format.date ?? 'D MMMM YYYY');
      }
      if (format.date) notDates.push(`{{${name}}} is "${raw}"`);
    }
    if (format.number) {
      const n = parseNumberValue(raw);
      if (n !== null) {
        formatted = true;
        return formatNumber(n, format.number);
      }
      notNumbers.push(`{{${name}}} is "${raw}"`);
    }
    return raw;
  });

  if (!formatted) {
    if (format.date && notDates[0]) warnings.push(`${notDates[0]}, which is not a recognisable date, so it was used as written.`);
    else if (format.number && notNumbers[0]) warnings.push(`${notNumbers[0]}, which is not a number, so it was used as written.`);
  }

  const tidy = substituted
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .trim();

  return { value: format.case ? applyCase(tidy, format.case) : tidy, missing, warnings };
}

export interface ResolvedField {
  id: string;
  label: string;
  value: string;
  missing: string[];
  required: boolean;
  usedFallback: boolean;
  /** Required field with a missing variable: this recipient must be skipped. */
  blocking: boolean;
  warnings: string[];
}

export function resolveField(field: DocumentField, data: Record<string, unknown>, system: SystemValues): ResolvedField {
  const resolved = resolveText(field.value, data, system, field.format);
  let value = resolved.value;
  let usedFallback = false;

  if (resolved.missing.length > 0 && !field.required && field.fallback) {
    const allMissing = resolved.missing.length === variablesIn(field.value).length;
    if (allMissing || value === '') {
      value = field.format.case ? applyCase(field.fallback, field.format.case) : field.fallback;
      usedFallback = true;
    }
  }

  return {
    id: field.id,
    label: field.label,
    value,
    missing: resolved.missing,
    required: field.required,
    usedFallback,
    blocking: field.required && resolved.missing.length > 0,
    warnings: resolved.warnings,
  };
}

/** Checkbox semantics for a resolved value. */
export function isTruthy(value: string): boolean {
  return ['yes', 'y', 'true', '1', 'checked', 'on', 'x', '✓', '✔', 'agreed', 'accepted'].includes(value.trim().toLowerCase());
}

// ── File names ───────────────────────────────────────────────────────────

export function sanitizeFileName(name: string, fallbackBase = 'Document'): string {
  const clean = (s: string) =>
    s
      .replace(/\.pdf\s*$/i, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/(\s*-\s*){2,}/g, ' - ')
      .replace(/^[\s.\-_,]+|[\s.\-_,]+$/g, '');
  let base = clean(name);
  if (!base) base = clean(fallbackBase) || 'Document';
  if (base.length > 120) base = base.slice(0, 120).trim();
  return `${base}.pdf`;
}

export function resolveFileName(pattern: string, data: Record<string, unknown>, system: SystemValues, fallbackBase: string): string {
  return sanitizeFileName(resolveText(pattern, data, system).value, fallbackBase);
}

// ── Auto-map form fields to columns ──────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const SYNONYMS: Record<string, string[]> = {
  name: ['fullname', 'studentname', 'candidatename', 'applicantname', 'nameofstudent', 'nameofcandidate', 'learnername'],
  email: ['emailaddress', 'emailid', 'mail', 'studentemail', 'mailid'],
  phone: ['mobile', 'mobileno', 'mobilenumber', 'phonenumber', 'phoneno', 'contactnumber', 'contactno'],
  date: ['dated', 'todaysdate', 'currentdate'],
};

/**
 * Best guess of which dataset column (or system variable) a PDF form field
 * holds, from its name: "student_name" → Name, "txtEmailAddress" → Email.
 * Returns null rather than a weak match — a wrong auto-map is worse than none.
 */
export function guessVariableForFormField(fieldName: string, columns: string[]): string | null {
  const raw = norm(fieldName);
  if (!raw) return null;
  const f = raw.replace(/^(txt|text|fld|field|tf)/, '').replace(/(txt|text|fld|field|\d+)$/, '') || raw;
  const cols = columns.map((c) => ({ c, n: norm(c) })).filter((x) => x.n);

  const exact = cols.find((x) => x.n === f || x.n === raw);
  if (exact) return exact.c;

  for (const [canonical, alts] of Object.entries(SYNONYMS)) {
    if (f === canonical || alts.includes(f)) {
      const col = cols.find((x) => x.n === canonical || alts.includes(x.n));
      if (col) return col.c;
      if (canonical === 'date') return 'Today';
    }
  }

  const contained = cols
    .filter((x) => x.n.length >= 4 && (f.includes(x.n) || x.n.includes(f)))
    .sort((a, b) => b.n.length - a.n.length)[0];
  return contained?.c ?? null;
}
