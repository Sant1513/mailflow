import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export interface SignedPdfInput {
  title: string;
  content: string;        // HTML content (will be stripped to plain text for PDF)
  recipientName: string;
  recipientEmail: string;
  fieldValues: Record<string, string>;
  signatureImage: string; // base64 data URL ("data:image/png;base64,...") or raw base64
  signedAt: Date;
  signerIp: string;
}

/**
 * Replace characters outside WinAnsi (the encoding used by pdf-lib's standard fonts)
 * so drawText never throws. Covers the most common Unicode used in Indian HR docs.
 */
function sanitizeForPdf(text: string): string {
  return text
    .replace(/₹/g, 'Rs.')
    .replace(/€/g, 'EUR ')
    .replace(/£/g, 'GBP ')
    .replace(/—/g, '--')        // em dash
    .replace(/–/g, '-')         // en dash
    .replace(/[‘’]/g, "'") // curly single quotes
    .replace(/[“”]/g, '"') // curly double quotes
    .replace(/…/g, '...')       // ellipsis
    .replace(/•/g, '*')         // bullet
    .replace(/©/g, '(c)')       // ©
    .replace(/®/g, '(R)')       // ®
    .replace(/™/g, '(TM)')      // ™
    .replace(/[^\x00-\xFF]/g, '?');  // any remaining non-Latin → ?
}

/** Strip HTML to plain text, preserving paragraph and line-break structure. */
function stripHtml(html: string): string {
  return html
    // Remove style/script block contents (not just the tags)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Block-level elements → newline so paragraphs don't run together
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse 3+ consecutive blank lines to a single blank line
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Wrap a single line at `maxChars` characters, returning an array of wrapped lines. */
function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const words = line.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + (current ? ' ' : '') + word).length > maxChars) {
      if (current) lines.push(current);
      // If a single word exceeds maxChars, hard-break it
      if (word.length > maxChars) {
        let remaining = word;
        while (remaining.length > maxChars) {
          lines.push(remaining.slice(0, maxChars));
          remaining = remaining.slice(maxChars);
        }
        current = remaining;
      } else {
        current = word;
      }
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Convert body text into wrapped lines, preserving paragraph breaks. */
function wrapText(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const result: string[] = [];
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi]!;
    const rawLines = para.split('\n');
    for (const rawLine of rawLines) {
      const wrapped = wrapLine(rawLine.trim(), maxChars);
      result.push(...wrapped);
    }
    // Add one blank line between paragraphs (skip after the last one)
    if (pi < paragraphs.length - 1) result.push('');
  }
  return result;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const BODY_SIZE = 11;
const HEADING_SIZE = 16;
const LINE_HEIGHT_BODY = 16;
const LINE_HEIGHT_HEADING = 24;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const MAX_CHARS = 90; // approximate chars at 11pt Helvetica on usable width

interface DrawState {
  doc: PDFDocument;
  font: Awaited<ReturnType<PDFDocument['embedFont']>>;
  boldFont: Awaited<ReturnType<PDFDocument['embedFont']>>;
  page: ReturnType<PDFDocument['addPage']>;
  y: number;
}

function newPage(state: DrawState): void {
  state.page = state.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  state.y = PAGE_HEIGHT - MARGIN;
}

function ensureSpace(state: DrawState, needed: number): void {
  if (state.y - needed < MARGIN) {
    newPage(state);
  }
}

function drawHeading(state: DrawState, text: string): void {
  text = sanitizeForPdf(text);
  ensureSpace(state, LINE_HEIGHT_HEADING + 8);
  state.y -= 8;
  state.page.drawText(text, {
    x: MARGIN,
    y: state.y - HEADING_SIZE,
    size: HEADING_SIZE,
    font: state.boldFont,
    color: rgb(0.1, 0.1, 0.1),
  });
  state.y -= LINE_HEIGHT_HEADING;
}

function drawBody(state: DrawState, text: string): void {
  text = sanitizeForPdf(text);
  const lines = wrapText(text, MAX_CHARS);
  for (const line of lines) {
    ensureSpace(state, LINE_HEIGHT_BODY);
    if (line.trim()) {
      state.page.drawText(line, {
        x: MARGIN,
        y: state.y - BODY_SIZE,
        size: BODY_SIZE,
        font: state.font,
        color: rgb(0.15, 0.15, 0.15),
      });
    }
    state.y -= LINE_HEIGHT_BODY;
  }
}

function drawLabelValue(state: DrawState, label: string, value: string): void {
  const fullLine = sanitizeForPdf(`${label}: ${value}`);
  const lines = wrapLine(fullLine, MAX_CHARS);
  for (const line of lines) {
    ensureSpace(state, LINE_HEIGHT_BODY);
    state.page.drawText(line, {
      x: MARGIN,
      y: state.y - BODY_SIZE,
      size: BODY_SIZE,
      font: state.font,
      color: rgb(0.2, 0.2, 0.2),
    });
    state.y -= LINE_HEIGHT_BODY;
  }
}

function drawDivider(state: DrawState): void {
  ensureSpace(state, 16);
  state.y -= 8;
  state.page.drawLine({
    start: { x: MARGIN, y: state.y },
    end: { x: PAGE_WIDTH - MARGIN, y: state.y },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });
  state.y -= 8;
}

/**
 * Generates a signed PDF from the signing request data.
 * Returns the PDF as a Buffer.
 */
export async function generateSignedPdf(input: SignedPdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const state: DrawState = {
    doc,
    font,
    boldFont,
    page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN,
  };

  // ── Page 1: Title + signing header ────────────────────────────────────────
  drawHeading(state, input.title);
  drawDivider(state);

  const signedDateStr = input.signedAt.toUTCString();
  drawBody(
    state,
    `This document was signed by ${input.recipientName} <${input.recipientEmail}> on ${signedDateStr}.`
  );
  state.y -= 8;
  drawDivider(state);
  state.y -= 8;

  // ── Document content (HTML stripped, variables substituted) ───────────────
  let processedContent = input.content;
  for (const [key, value] of Object.entries(input.fieldValues)) {
    processedContent = processedContent.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  const plainContent = stripHtml(processedContent);
  if (plainContent) {
    drawBody(state, plainContent);
  }

  // ── Certificate of Completion (new section, possibly new page) ─────────────
  // Force a new page for the certificate
  newPage(state);

  drawHeading(state, 'Certificate of Completion');
  drawDivider(state);

  drawLabelValue(state, 'Document', input.title);
  drawLabelValue(state, 'Signer name', input.recipientName);
  drawLabelValue(state, 'Signer email', input.recipientEmail);
  drawLabelValue(state, 'Signed at', signedDateStr);
  drawLabelValue(state, 'IP address', input.signerIp);

  if (Object.keys(input.fieldValues).length > 0) {
    state.y -= 8;
    ensureSpace(state, LINE_HEIGHT_BODY);
    state.page.drawText('Field values:', {
      x: MARGIN,
      y: state.y - BODY_SIZE,
      size: BODY_SIZE,
      font: boldFont,
      color: rgb(0.1, 0.1, 0.1),
    });
    state.y -= LINE_HEIGHT_BODY;

    for (const [key, value] of Object.entries(input.fieldValues)) {
      drawLabelValue(state, `  ${key}`, String(value));
    }
  }

  // ── Embed signature image ─────────────────────────────────────────────────
  const rawBase64 = input.signatureImage.startsWith('data:')
    ? input.signatureImage.replace(/^data:image\/png;base64,/, '')
    : input.signatureImage;

  try {
    const pngBytes = Buffer.from(rawBase64, 'base64');
    const pngImage = await doc.embedPng(pngBytes);

    const maxW = USABLE_WIDTH;
    const maxH = 120;
    const { width: iw, height: ih } = pngImage.scale(1);
    const scale = Math.min(maxW / iw, maxH / ih, 1);
    const drawW = iw * scale;
    const drawH = ih * scale;

    ensureSpace(state, drawH + 40);
    state.y -= 16;
    state.page.drawText('Signature:', {
      x: MARGIN,
      y: state.y - BODY_SIZE,
      size: BODY_SIZE,
      font: boldFont,
      color: rgb(0.1, 0.1, 0.1),
    });
    state.y -= LINE_HEIGHT_BODY + 4;

    state.page.drawImage(pngImage, {
      x: MARGIN,
      y: state.y - drawH,
      width: drawW,
      height: drawH,
    });
    state.y -= drawH + 12;
  } catch {
    // If signature PNG can't be embedded, note it in text
    drawBody(state, '[Signature image could not be embedded]');
  }

  drawDivider(state);
  drawBody(
    state,
    'This certificate was generated automatically by MailFlow and serves as an audit record of the signing event.'
  );

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}
