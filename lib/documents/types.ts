import { z } from 'zod';

/**
 * Personalised documents: shared types and validation schemas.
 *
 * A document template is an uploaded PDF plus a list of fields. Each field
 * says WHAT to write (a value with {{Variables}}) and WHERE to write it —
 * either into an existing fillable form field, or as text inside a box on a
 * page. Coordinates are PDF points measured from the TOP-LEFT of the page's
 * visible box, which is what the editor works in; the renderer converts to
 * PDF user space (bottom-left origin).
 *
 * This module is isomorphic: the editor and the API validate with the same
 * schemas.
 */

export const DATE_FORMATS = ['D MMM YYYY', 'D MMMM YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MMMM D, YYYY'] as const;
export const NUMBER_FORMATS = ['indian', 'international', 'inr'] as const;
export const CASE_FORMATS = ['upper', 'lower', 'title'] as const;
export const FONTS = ['Helvetica', 'HelveticaBold', 'TimesRoman', 'TimesRomanBold', 'Courier'] as const;
export const LOCK_MODES = ['FLATTEN', 'LOCK_FILLED', 'EDITABLE'] as const;

export type DateFormat = (typeof DATE_FORMATS)[number];
export type NumberFormat = (typeof NUMBER_FORMATS)[number];
export type CaseFormat = (typeof CASE_FORMATS)[number];
export type FontName = (typeof FONTS)[number];
export type LockMode = (typeof LOCK_MODES)[number];

export const LOCK_MODE_LABELS: Record<LockMode, { label: string; help: string }> = {
  FLATTEN: { label: 'Flatten — nothing editable', help: 'Best for agreements, offer letters and certificates.' },
  LOCK_FILLED: {
    label: 'Lock filled fields — student fills the rest',
    help: 'Pre-filled fields are read-only; every other form field stays fillable. Best for forms sent back to you.',
  },
  EDITABLE: { label: 'Editable — every field stays editable', help: 'The student can change pre-filled values.' },
};

export const formTargetSchema = z.object({
  kind: z.literal('form'),
  fieldName: z.string().min(1).max(300),
});

export const textTargetSchema = z.object({
  kind: z.literal('text'),
  page: z.number().int().min(0).max(999),
  x: z.number().min(0).max(20000),
  y: z.number().min(0).max(20000),
  width: z.number().min(4).max(20000),
  height: z.number().min(4).max(20000),
});

export const fieldFormatSchema = z.object({
  date: z.enum(DATE_FORMATS).optional(),
  number: z.enum(NUMBER_FORMATS).optional(),
  case: z.enum(CASE_FORMATS).optional(),
});

export const fieldStyleSchema = z.object({
  font: z.enum(FONTS).default('Helvetica'),
  fontSize: z.number().min(4).max(72).default(11),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #111111')
    .default('#111111'),
  align: z.enum(['left', 'center', 'right']).default('left'),
  multiline: z.boolean().default(false),
});

export const documentFieldSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1, 'Every field needs a label').max(80),
  /** Text with {{Variables}}, e.g. "{{FirstName}} {{LastName}}". */
  value: z.string().max(2000),
  /** Empty value blocks this recipient (skip reason) instead of sending a blank. */
  required: z.boolean().default(true),
  /** Used when the value is empty and the field is optional. */
  fallback: z.string().max(500).optional(),
  format: fieldFormatSchema.default({}),
  target: z.discriminatedUnion('kind', [formTargetSchema, textTargetSchema]),
  style: fieldStyleSchema.default({}),
});

export type DocumentField = z.infer<typeof documentFieldSchema>;
export type DocumentFieldInput = z.input<typeof documentFieldSchema>;
export type TextTarget = z.infer<typeof textTargetSchema>;

export const documentFieldsSchema = z.array(documentFieldSchema).max(100, 'At most 100 fields per document');

export const documentConfigSchema = z.object({
  fields: documentFieldsSchema,
  fileNamePattern: z.string().trim().min(1, 'A file name is required').max(200),
  lockMode: z.enum(LOCK_MODES),
  stampReference: z.boolean(),
});

export type DocumentConfig = z.infer<typeof documentConfigSchema>;

export interface PageInfo {
  width: number;
  height: number;
  /** 0, 90, 180 or 270. */
  rotation: number;
}

export type FormFieldType = 'text' | 'checkbox' | 'dropdown' | 'radio' | 'optionList' | 'button' | 'signature' | 'unknown';

export interface DetectedFormField {
  name: string;
  type: FormFieldType;
  /** Zero-based page of the field's first widget; null when it has no placed widget. */
  page: number | null;
  /** Top-left-origin rectangle in points; null on rotated pages or without a widget. */
  rect: { x: number; y: number; width: number; height: number } | null;
  options?: string[];
  maxLength?: number | null;
  multiline?: boolean;
  readOnly?: boolean;
}

export interface DocumentInspection {
  pageCount: number;
  pages: PageInfo[];
  formFields: DetectedFormField[];
  hasXfa: boolean;
}

export interface DocumentIssue {
  level: 'error' | 'warning';
  message: string;
  fieldId?: string;
}

/** Stored on Attachment.fieldValues — everything needed to regenerate the exact PDF. */
export interface DocumentSnapshot {
  v: 1;
  /** fieldId → final text written (already formatted, fallback applied). */
  values: Record<string, string>;
  reference: string;
  recipient: string | null;
  /** ISO timestamp used as the PDF creation / modification date. */
  issuedAt: string;
  /** Human date printed in the reference stamp, e.g. "10 Sep 2026". */
  issuedLabel: string;
  title: string;
  subject: string;
}

/** Tolerant parse of the JSON column: invalid entries are dropped rather than crashing a page. */
export function parseFields(json: unknown): DocumentField[] {
  if (!Array.isArray(json)) return [];
  const out: DocumentField[] = [];
  for (const item of json) {
    const parsed = documentFieldSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function parseSnapshot(json: unknown): DocumentSnapshot | null {
  if (!json || typeof json !== 'object') return null;
  const s = json as Partial<DocumentSnapshot>;
  if (s.v !== 1 || !s.values || typeof s.reference !== 'string' || typeof s.issuedAt !== 'string') return null;
  return {
    v: 1,
    values: s.values as Record<string, string>,
    reference: s.reference,
    recipient: s.recipient ?? null,
    issuedAt: s.issuedAt,
    issuedLabel: s.issuedLabel ?? s.issuedAt.slice(0, 10),
    title: s.title ?? 'Document',
    subject: s.subject ?? '',
  };
}

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_PAGES = 50;
export const MAX_DOCUMENTS_PER_CAMPAIGN = 5;
/** Raw attachment bytes per email; base64 adds ~33%, keeping the message under Gmail's 25 MB. */
export const MAX_ATTACHMENT_BYTES_PER_EMAIL = 18 * 1024 * 1024;
