import {
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFForm,
  type PDFPage,
} from 'pdf-lib';
import { loadPdf, normaliseRotation } from './inspect';
import { isTruthy } from './values';
import { sha256Hex } from './reference';
import type { DocumentField, FontName, LockMode, TextTarget } from './types';

/**
 * Generates one personalised copy of a document.
 *
 * Deterministic by construction: the PDF is loaded without metadata side
 * effects, pdf-lib names new resources from a per-document RNG with a fixed
 * seed, and the creation/modification dates come from the frozen snapshot.
 * Same inputs → byte-identical output, which is what lets "download sent
 * copy" prove it matches the SHA-256 recorded when the email went out.
 */

/** A problem generating this copy (bad value for a dropdown, missing form field…). Safe to show. */
export class DocumentRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentRenderError';
  }
}

export interface RenderDocumentInput {
  fileBytes: Uint8Array;
  fields: DocumentField[];
  /** fieldId → final text (formatted, fallback applied). */
  values: Record<string, string>;
  lockMode: LockMode;
  /** Small reference line at the foot of every page; null for none. */
  stamp: { reference: string; recipient: string | null; issuedLabel: string } | null;
  metadata: { title: string; subject: string; reference: string; issuedAt: Date };
}

export interface RenderDocumentOutput {
  bytes: Uint8Array;
  sha256: string;
  warnings: string[];
}

const STANDARD_FONTS: Record<FontName, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  HelveticaBold: StandardFonts.HelveticaBold,
  TimesRoman: StandardFonts.TimesRoman,
  TimesRomanBold: StandardFonts.TimesRomanBold,
  Courier: StandardFonts.Courier,
};

const MIN_FONT_SIZE = 6;
const PADDING = 2;

// ── Character set ────────────────────────────────────────────────────────

/** cp1252 characters outside Latin-1 that the standard fonts' WinAnsi encoding still covers. */
const CP1252_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019,
  0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

const SUBSTITUTES: Record<string, string> = {
  '₹': 'Rs.',
  ' ': ' ',
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '−': '-',
  '′': "'",
  '″': '"',
  '​': '',
  '\t': ' ',
};

function encodable(codePoint: number): boolean {
  return (codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff) || CP1252_EXTRA.has(codePoint);
}

/**
 * The 14 standard PDF fonts only encode WinAnsi (Latin). Anything else is
 * mapped to its closest Latin form (é stays, ş → s, ₹ → Rs.) or replaced
 * with "?" and reported, rather than crashing the whole send.
 */
export function toWinAnsi(text: string): { text: string; replaced: string[] } {
  let out = '';
  const replaced = new Set<string>();
  for (const ch of text) {
    if (ch === '\n') {
      out += '\n';
      continue;
    }
    if (ch === '\r') continue;
    const codePoint = ch.codePointAt(0) ?? 0;
    if (encodable(codePoint)) {
      out += ch;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(SUBSTITUTES, ch)) {
      out += SUBSTITUTES[ch] ?? '';
      continue;
    }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (base && [...base].every((c) => encodable(c.codePointAt(0) ?? 0))) {
      out += base;
      continue;
    }
    replaced.add(ch);
    out += '?';
  }
  return { text: out, replaced: [...replaced] };
}

function hexToRgb(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// ── Text layout ──────────────────────────────────────────────────────────

export function fitSingleLine(font: PDFFont, text: string, size: number, maxWidth: number): { text: string; size: number; truncated: boolean } {
  let s = size;
  while (s > MIN_FONT_SIZE && font.widthOfTextAtSize(text, s) > maxWidth) s = Math.max(MIN_FONT_SIZE, s - 0.25);
  if (font.widthOfTextAtSize(text, s) <= maxWidth) return { text, size: s, truncated: false };
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, s) > maxWidth) t = t.slice(0, -1);
  return { text: `${t.trimEnd()}…`, size: s, truncated: true };
}

export function wrapLines(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        // A single word wider than the box: break it by characters.
        let chunk = '';
        for (const ch of word) {
          if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawTextBox(page: PDFPage, font: PDFFont, target: TextTarget, value: string, field: DocumentField, warnings: string[]) {
  const style = field.style;
  const crop = page.getCropBox();
  const color = hexToRgb(style.color);
  const innerWidth = Math.max(1, target.width - PADDING * 2);
  const innerHeight = Math.max(1, target.height - PADDING * 2);
  const left = crop.x + target.x;
  const top = crop.y + crop.height - target.y;
  const xFor = (width: number) =>
    style.align === 'center'
      ? left + (target.width - width) / 2
      : style.align === 'right'
        ? left + target.width - PADDING - width
        : left + PADDING;

  if (style.multiline) {
    const lineHeight = (s: number) => s * 1.2;
    let size = style.fontSize;
    let lines = wrapLines(font, value, size, innerWidth);
    while (size > MIN_FONT_SIZE && lines.length * lineHeight(size) > innerHeight) {
      size = Math.max(MIN_FONT_SIZE, size - 0.5);
      lines = wrapLines(font, value, size, innerWidth);
    }
    const maxLines = Math.max(1, Math.floor(innerHeight / lineHeight(size)));
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      let last = lines[maxLines - 1] ?? '';
      while (last.length > 0 && font.widthOfTextAtSize(`${last}…`, size) > innerWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last.trimEnd()}…`;
      warnings.push(`"${field.label}" did not fit its box, so the text was cut off.`);
    }
    let y = top - PADDING - font.heightAtSize(size, { descender: false });
    for (const line of lines) {
      if (line) page.drawText(line, { x: xFor(font.widthOfTextAtSize(line, size)), y, size, font, color });
      y -= lineHeight(size);
    }
    return;
  }

  const oneLine = value.replace(/\s*\n\s*/g, ' ');
  let size = style.fontSize;
  while (size > MIN_FONT_SIZE && font.heightAtSize(size) > target.height) size = Math.max(MIN_FONT_SIZE, size - 0.5);
  const fit = fitSingleLine(font, oneLine, size, innerWidth);
  if (fit.truncated) warnings.push(`"${field.label}" did not fit its box, so the text was cut off.`);
  const textHeight = font.heightAtSize(fit.size, { descender: false });
  const y = top - target.height + (target.height - textHeight) / 2;
  page.drawText(fit.text, { x: xFor(font.widthOfTextAtSize(fit.text, fit.size)), y, size: fit.size, font, color });
}

// ── Form fields ──────────────────────────────────────────────────────────

function matchOption(options: string[], value: string): string | undefined {
  return options.find((o) => o === value) ?? options.find((o) => o.toLowerCase() === value.toLowerCase());
}

function fillFormField(form: PDFForm, field: DocumentField & { target: { kind: 'form' } }, value: string, lockMode: LockMode, warnings: string[]) {
  const name = field.target.fieldName;
  let pdfField;
  try {
    pdfField = form.getField(name);
  } catch {
    throw new DocumentRenderError(`The form field "${name}" (used by "${field.label}") is not in this PDF.`);
  }

  const v = value.trim();
  if (pdfField instanceof PDFTextField) {
    let text = value;
    if (!pdfField.isMultiline()) text = text.replace(/\s*\n\s*/g, ' ');
    const max = pdfField.getMaxLength();
    if (max !== undefined && text.length > max) {
      text = text.slice(0, max);
      warnings.push(`"${field.label}" was cut to ${max} characters, the limit set in the PDF form.`);
    }
    pdfField.setText(text === '' ? undefined : text);
  } else if (pdfField instanceof PDFCheckBox) {
    if (isTruthy(v)) pdfField.check();
    else pdfField.uncheck();
  } else if (pdfField instanceof PDFDropdown || pdfField instanceof PDFOptionList || pdfField instanceof PDFRadioGroup) {
    const options = pdfField.getOptions();
    if (!v) {
      pdfField.clear();
    } else {
      const match = matchOption(options, v);
      if (match) pdfField.select(match);
      else if (pdfField instanceof PDFDropdown && pdfField.isEditable()) pdfField.select(v);
      else {
        throw new DocumentRenderError(`"${field.label}" is "${v}", which is not one of the options in the PDF (${options.join(', ')}).`);
      }
    }
  } else {
    throw new DocumentRenderError(`"${field.label}" targets "${name}", which is not a fillable field.`);
  }

  if (lockMode === 'LOCK_FILLED' && v !== '') pdfField.enableReadOnly();
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function renderDocument(input: RenderDocumentInput): Promise<RenderDocumentOutput> {
  const warnings: string[] = [];
  const doc = await loadPdf(input.fileBytes);
  const pages = doc.getPages();

  const fonts = new Map<FontName, PDFFont>();
  const font = (name: FontName) => {
    let embedded = fonts.get(name);
    if (!embedded) {
      embedded = doc.embedStandardFont(STANDARD_FONTS[name]);
      fonts.set(name, embedded);
    }
    return embedded;
  };

  const replaced = new Set<string>();
  const clean = (text: string) => {
    const r = toWinAnsi(text);
    r.replaced.forEach((c) => replaced.add(c));
    return r.text;
  };

  const hasForm = !!doc.catalog.getAcroForm();
  const usesForm = input.fields.some((f) => f.target.kind === 'form');
  const form = hasForm || usesForm ? doc.getForm() : null;

  for (const field of input.fields) {
    const value = clean(input.values[field.id] ?? '');
    if (field.target.kind === 'form') {
      fillFormField(form as PDFForm, field as DocumentField & { target: { kind: 'form' } }, value, input.lockMode, warnings);
      continue;
    }
    const target = field.target;
    const page = pages[target.page];
    if (!page) {
      throw new DocumentRenderError(`"${field.label}" is on page ${target.page + 1}, but the PDF has ${pages.length} page(s).`);
    }
    if (normaliseRotation(page.getRotation().angle) !== 0) {
      throw new DocumentRenderError(`"${field.label}" is a text box on rotated page ${target.page + 1}; use a form field there.`);
    }
    if (value) drawTextBox(page, font(field.style.font), target, value, field, warnings);
  }

  if (form) {
    try {
      if (form.hasXFA()) form.deleteXFA();
      form.updateFieldAppearances(font('Helvetica'));
      if (input.lockMode === 'FLATTEN') form.flatten({ updateFieldAppearances: true });
    } catch (err) {
      if (err instanceof DocumentRenderError) throw err;
      throw new DocumentRenderError(
        `MailFlow could not ${input.lockMode === 'FLATTEN' ? 'flatten' : 'update'} this PDF's form (${(err as Error).message}). Try the "Lock filled fields" option, or re-save the PDF.`
      );
    }
  }

  if (input.stamp) {
    const stampFont = font('Helvetica');
    const text = clean(
      `Ref ${input.stamp.reference}${input.stamp.recipient ? ` · Prepared for ${input.stamp.recipient}` : ''} · Issued ${input.stamp.issuedLabel}`
    );
    let rotated = 0;
    for (const page of pages) {
      if (normaliseRotation(page.getRotation().angle) !== 0) {
        rotated += 1;
        continue;
      }
      const crop = page.getCropBox();
      const fit = fitSingleLine(stampFont, text, 6.5, Math.max(40, crop.width - 40));
      const width = stampFont.widthOfTextAtSize(fit.text, fit.size);
      page.drawText(fit.text, { x: crop.x + (crop.width - width) / 2, y: crop.y + 10, size: fit.size, font: stampFont, color: rgb(0.45, 0.47, 0.5) });
    }
    if (rotated > 0) warnings.push(`The reference line was not printed on ${rotated} rotated page(s).`);
  }

  doc.setTitle(clean(input.metadata.title));
  doc.setSubject(clean(input.metadata.subject));
  doc.setKeywords([input.metadata.reference]);
  doc.setCreator('MailFlow');
  doc.setProducer('MailFlow');
  doc.setCreationDate(input.metadata.issuedAt);
  doc.setModificationDate(input.metadata.issuedAt);

  if (replaced.size > 0) {
    warnings.push(`These characters are not supported by the PDF's standard fonts and were replaced with "?": ${[...replaced].join(' ')}`);
  }

  const bytes = await doc.save({ updateFieldAppearances: false });
  return { bytes, sha256: sha256Hex(bytes), warnings };
}
