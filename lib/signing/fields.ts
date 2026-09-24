export interface SigningFieldDef {
  key: string;
  label: string;
  defaultValue?: string;
}

export interface BulkSignerConfig {
  index: number;
  role: string;
  nameColumn: string;
  emailColumn: string;
  /** 'fixed' = the same person signs every row (e.g. the Masai signatory). */
  source?: 'csv' | 'fixed';
  fixedName?: string;
  fixedEmail?: string;
}

export const SIGNER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isFixedSigner(s: Pick<BulkSignerConfig, 'source'>): boolean {
  return s.source === 'fixed';
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const INTERNAL_PREFIX = '__';

export function normalizeFieldKey(raw: string): string {
  return raw.trim().replace(/[^\w]/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export function isInternalSigningField(key: string): boolean {
  return key.startsWith(INTERNAL_PREFIX);
}

export function extractSigningVariables(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(PLACEHOLDER_RE)) {
    const key = normalizeFieldKey(match[1] ?? '');
    if (key && !isInternalSigningField(key)) found.add(key);
  }
  return [...found];
}

export function mergeSigningFieldDefs(content: string, fieldDefs: SigningFieldDef[] = []): SigningFieldDef[] {
  const byKey = new Map<string, SigningFieldDef>();
  for (const key of extractSigningVariables(content)) {
    byKey.set(key, { key, label: labelForSigningField(key) });
  }
  for (const def of fieldDefs) {
    const key = normalizeFieldKey(def.key);
    if (!key || isInternalSigningField(key)) continue;
    byKey.set(key, {
      key,
      label: def.label?.trim() || labelForSigningField(key),
      ...(def.defaultValue ? { defaultValue: def.defaultValue } : {}),
    });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function labelForSigningField(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function renderSigningContent(
  content: string,
  values: Record<string, string>,
  options: { highlight?: boolean; friendlyBlanks?: boolean } = {},
): string {
  return content.replace(PLACEHOLDER_RE, (_match, rawKey: string) => {
    const key = normalizeFieldKey(rawKey);
    const value = values[key] ?? '';
    if (!options.highlight) return escapeHtml(value);
    if (value.trim()) {
      return `<mark style="background:#fef3c7;border-radius:2px;padding:0 2px;font-weight:600">${escapeHtml(value)}</mark>`;
    }
    // Blank field: show a readable label ("Student Name") rather than {{student_name}}.
    const text = options.friendlyBlanks ? labelForSigningField(key) : `{{${key}}}`;
    return `<span style="background:#fee2e2;border-radius:2px;padding:0 2px;color:#991b1b">${escapeHtml(text)}</span>`;
  });
}

export function publicSigningFieldValues(values: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!values || typeof values !== 'object') return out;
  for (const [key, value] of Object.entries(values)) {
    if (isInternalSigningField(key)) continue;
    out[key] = String(value ?? '');
  }
  return out;
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function defaultBulkSigners(): BulkSignerConfig[] {
  return [{ index: 1, role: 'Signer 1', nameColumn: 'signer_1_name', emailColumn: 'signer_1_email' }];
}

/**
 * Cleans a signer setup for use. Apply this when the setup is *used* (parsing,
 * sending, saving) — never to the text boxes while someone is typing, or spaces,
 * "@" and "." get rewritten under their cursor.
 */
export function normalizeBulkSigners(input: BulkSignerConfig[]): BulkSignerConfig[] {
  const signers = input
    .slice(0, 3)
    .map((s, i): BulkSignerConfig => {
      // Signer 1 is the row's recipient, so it always comes from the CSV/table.
      const fixed = i > 0 && s.source === 'fixed';
      return {
        index: i + 1,
        role: (s.role ?? '').trim() || `Signer ${i + 1}`,
        nameColumn: normalizeFieldKey(s.nameColumn || `signer_${i + 1}_name`) || `signer_${i + 1}_name`,
        emailColumn: normalizeFieldKey(s.emailColumn || `signer_${i + 1}_email`) || `signer_${i + 1}_email`,
        ...(fixed
          ? { source: 'fixed' as const, fixedName: (s.fixedName ?? '').trim(), fixedEmail: (s.fixedEmail ?? '').trim().toLowerCase() }
          : { source: 'csv' as const }),
      };
    });
  return signers.length ? signers : defaultBulkSigners();
}

// ── Multi-signer helpers ──────────────────────────────────────────────────

export type SigningOrderType = 'SEQUENTIAL' | 'PARALLEL';

export interface SignerFieldAssignment {
  signerIndex: number;
  role: string;
  assignedFields: string[];
}

export function computeLockedFieldsForSigner(
  allFieldKeys: string[],
  assignedFields: string[],
): string[] {
  if (assignedFields.length === 0) return allFieldKeys;
  return allFieldKeys.filter((k) => !assignedFields.includes(k));
}

function isFilled(values: Record<string, string>, key: string): boolean {
  return (values[key] ?? '').trim().length > 0;
}

/**
 * Per-signer assignments for one document row. Blank fields that nobody was
 * explicitly assigned go to the first signer, so every blank field has exactly
 * one owner on the signing page.
 */
export function effectiveAssignedFields(
  fieldKeys: string[],
  values: Record<string, string>,
  explicitBySigner: string[][],
): string[][] {
  if (explicitBySigner.length <= 1) return explicitBySigner.map((a) => [...a]);
  const claimed = new Set(explicitBySigner.flat());
  const orphanBlanks = fieldKeys.filter((k) => !isFilled(values, k) && !claimed.has(k));
  return explicitBySigner.map((assigned, i) => (i === 0 ? [...new Set([...assigned, ...orphanBlanks])] : [...assigned]));
}

/**
 * Fields a signer may not edit: everything the sender filled in, plus (for
 * multi-signer documents) blank fields owned by another signer.
 */
export function lockedKeysForSigner(
  fieldKeys: string[],
  values: Record<string, string>,
  assignedFields: string[],
  isMultiSigner: boolean,
): string[] {
  const filled = fieldKeys.filter((k) => isFilled(values, k));
  if (!isMultiSigner) return filled;
  const othersBlanks = fieldKeys.filter((k) => !isFilled(values, k) && !assignedFields.includes(k));
  return [...filled, ...othersBlanks];
}

export function lockedFieldsOf(values: unknown): string[] {
  if (!values || typeof values !== 'object') return [];
  const raw = (values as Record<string, unknown>).__lockedFields;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

export function mergeGroupFieldValues(
  existingValues: Record<string, string>,
  signerValues: Record<string, string>,
  assignedFields: string[],
): Record<string, string> {
  const merged = { ...existingValues };
  for (const key of assignedFields) {
    if (signerValues[key] !== undefined) merged[key] = signerValues[key];
  }
  return merged;
}

export function groupSigningStatus(
  totalSigners: number,
  signedCount: number,
): string {
  if (signedCount === 0) return 'PENDING';
  if (signedCount < totalSigners) return 'IN_PROGRESS';
  return 'COMPLETED';
}

export interface SignerSignature {
  signerName: string;
  signerEmail: string;
  signerRole: string;
  signatureImage: string;
  signedAt: Date;
  signerIp: string;
  signerOrder: number;
}
