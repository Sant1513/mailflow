/**
 * Re-generates signed PDFs for all SIGNED signing requests using the
 * updated pdf.ts logic (improved HTML stripping, no WinAnsi crash).
 *
 * Run:  node scripts/regen-signed-pdfs.mjs
 *
 * Requires: DATABASE_URL in .env (loaded via dotenv)
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const prisma = new PrismaClient();

// ── Exact copy of lib/documents/pdf.ts helpers ────────────────────────────

function sanitizeForPdf(text) {
  return text
    .replace(/₹/g, 'Rs.')
    .replace(/€/g, 'EUR ')
    .replace(/£/g, 'GBP ')
    .replace(/—/g, '--')
    .replace(/–/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/•/g, '*')
    .replace(/[^\x00-\xFF]/g, '?');
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '* ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wrapLine(line, maxChars) {
  if (line.length <= maxChars) return [line];
  const words = line.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + (current ? ' ' : '') + word).length > maxChars) {
      if (current) lines.push(current);
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

function wrapText(text, maxChars) {
  const paragraphs = text.split(/\n{2,}/);
  const result = [];
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const rawLines = paragraphs[pi].split('\n');
    for (const rawLine of rawLines) {
      result.push(...wrapLine(rawLine.trim(), maxChars));
    }
    if (pi < paragraphs.length - 1) result.push('');
  }
  return result;
}

const PAGE_WIDTH = 595, PAGE_HEIGHT = 842, MARGIN = 50;
const BODY_SIZE = 11, HEADING_SIZE = 16;
const LINE_HEIGHT_BODY = 16, LINE_HEIGHT_HEADING = 24;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const MAX_CHARS = 90;

function newPage(state) {
  state.page = state.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  state.y = PAGE_HEIGHT - MARGIN;
}
function ensureSpace(state, needed) {
  if (state.y - needed < MARGIN) newPage(state);
}
function drawHeading(state, text) {
  text = sanitizeForPdf(text);
  ensureSpace(state, LINE_HEIGHT_HEADING + 8);
  state.y -= 8;
  state.page.drawText(text, { x: MARGIN, y: state.y - HEADING_SIZE, size: HEADING_SIZE, font: state.boldFont, color: rgb(0.1, 0.1, 0.1) });
  state.y -= LINE_HEIGHT_HEADING;
}
function drawBody(state, text) {
  text = sanitizeForPdf(text);
  for (const line of wrapText(text, MAX_CHARS)) {
    ensureSpace(state, LINE_HEIGHT_BODY);
    if (line.trim()) {
      state.page.drawText(line, { x: MARGIN, y: state.y - BODY_SIZE, size: BODY_SIZE, font: state.font, color: rgb(0.15, 0.15, 0.15) });
    }
    state.y -= LINE_HEIGHT_BODY;
  }
}
function drawLabelValue(state, label, value) {
  const fullLine = sanitizeForPdf(`${label}: ${value}`);
  for (const line of wrapLine(fullLine, MAX_CHARS)) {
    ensureSpace(state, LINE_HEIGHT_BODY);
    state.page.drawText(line, { x: MARGIN, y: state.y - BODY_SIZE, size: BODY_SIZE, font: state.font, color: rgb(0.2, 0.2, 0.2) });
    state.y -= LINE_HEIGHT_BODY;
  }
}
function drawDivider(state) {
  ensureSpace(state, 16);
  state.y -= 8;
  state.page.drawLine({ start: { x: MARGIN, y: state.y }, end: { x: PAGE_WIDTH - MARGIN, y: state.y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  state.y -= 8;
}

async function generateSignedPdf(input) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const state = { doc, font, boldFont, page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), y: PAGE_HEIGHT - MARGIN };

  drawHeading(state, input.title);
  drawDivider(state);
  const signedDateStr = input.signedAt.toUTCString();
  drawBody(state, `This document was signed by ${input.recipientName} <${input.recipientEmail}> on ${signedDateStr}.`);
  state.y -= 8;
  drawDivider(state);
  state.y -= 8;

  let processedContent = input.content;
  for (const [key, value] of Object.entries(input.fieldValues)) {
    processedContent = processedContent.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  const plainContent = stripHtml(processedContent);
  if (plainContent) drawBody(state, plainContent);

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
    state.page.drawText('Field values:', { x: MARGIN, y: state.y - BODY_SIZE, size: BODY_SIZE, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
    state.y -= LINE_HEIGHT_BODY;
    for (const [key, value] of Object.entries(input.fieldValues)) {
      drawLabelValue(state, `  ${key}`, String(value));
    }
  }

  // Embed signature image
  const rawBase64 = input.signatureImage.startsWith('data:')
    ? input.signatureImage.replace(/^data:image\/png;base64,/, '')
    : input.signatureImage;

  try {
    const pngBytes = Buffer.from(rawBase64, 'base64');
    const pngImage = await doc.embedPng(pngBytes);
    const maxW = USABLE_WIDTH, maxH = 120;
    const { width: iw, height: ih } = pngImage.scale(1);
    const scale = Math.min(maxW / iw, maxH / ih, 1);
    const drawW = iw * scale, drawH = ih * scale;
    ensureSpace(state, drawH + 40);
    state.y -= 16;
    state.page.drawText('Signature:', { x: MARGIN, y: state.y - BODY_SIZE, size: BODY_SIZE, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
    state.y -= LINE_HEIGHT_BODY + 4;
    state.page.drawImage(pngImage, { x: MARGIN, y: state.y - drawH, width: drawW, height: drawH });
    state.y -= drawH + 12;
  } catch {
    drawBody(state, '[Signature image could not be embedded]');
  }

  drawDivider(state);
  drawBody(state, 'This certificate was generated automatically by MailFlow and serves as an audit record of the signing event.');

  return Buffer.from(await doc.save());
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const signed = await prisma.signingRequest.findMany({
    where: { status: 'SIGNED', signatureImage: { not: null } },
    select: {
      id: true, title: true, content: true,
      recipientName: true, recipientEmail: true,
      fieldValues: true, signatureImage: true,
      signedAt: true, signerIp: true,
    },
  });

  console.log(`Found ${signed.length} signed request(s) to regenerate.`);

  for (const req of signed) {
    try {
      const pdfBuffer = await generateSignedPdf({
        title: req.title,
        content: req.content,
        recipientName: req.recipientName,
        recipientEmail: req.recipientEmail,
        fieldValues: (req.fieldValues ?? {}),
        signatureImage: req.signatureImage,
        signedAt: req.signedAt ?? new Date(),
        signerIp: req.signerIp ?? 'unknown',
      });

      await prisma.signingRequest.update({
        where: { id: req.id },
        data: { signedPdfData: pdfBuffer.toString('base64') },
      });

      console.log(`  ✓  ${req.id}  "${req.title}" — ${req.recipientName}`);
    } catch (err) {
      console.error(`  ✗  ${req.id}  "${req.title}":`, err.message);
    }
  }

  console.log('\nDone.');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
