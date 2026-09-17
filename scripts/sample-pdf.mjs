/**
 * Generates a sample signed PDF using the current pdf.ts logic (re-implemented here
 * in plain JS so it can run without the full Next.js build).
 * Run: node scripts/sample-pdf.mjs
 */
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers (mirrors lib/documents/pdf.ts) ─────────────────────────────────

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

// ── Sample document ────────────────────────────────────────────────────────

const sampleContent = `<p><strong>INTERNSHIP OFFER LETTER</strong></p>
<p>Dear Rahul Sharma,</p>
<p>We are pleased to offer you an internship opportunity at Masai School, effective from <strong>1st October 2026</strong>.</p>
<p><strong>Internship Details:</strong></p>
<p>Duration: 3 months (October 2026 – December 2026)</p>
<p>Stipend: Rs. 15,000 per month</p>
<p>Role: Software Development Intern</p>
<p>Location: Bangalore, Karnataka (Remote)</p>
<p>By signing this document, you confirm your acceptance of the above internship offer and agree to abide by the company's policies and code of conduct during the internship period.</p>
<p>We look forward to your contribution and wish you a productive internship experience.</p>
<p>Regards,<br/>Placement Team<br/>Masai School</p>`;

const sampleFieldValues = {
  student_name: 'Rahul Sharma',
  student_id: 'MS2026001',
  stipend: 'Rs. 15,000/month',
  start_date: '1st October 2026',
};

// Make a fake 1×1 white PNG for the signature placeholder (we don't have a real signature here)
// We'll draw a text-style "signature" instead
async function run() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const state = { doc, font, boldFont, page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), y: PAGE_HEIGHT - MARGIN };

  // Page 1: title + signed-by header
  drawHeading(state, 'Masai School — Internship Offer Letter');
  drawDivider(state);
  const signedAt = new Date('2026-09-17T10:08:06Z');
  drawBody(state, `This document was signed by Rahul Sharma <rahul.sharma@example.com> on ${signedAt.toUTCString()}.`);
  state.y -= 8;
  drawDivider(state);
  state.y -= 8;

  // Substitute field values then strip HTML
  let processedContent = sampleContent;
  for (const [key, value] of Object.entries(sampleFieldValues)) {
    processedContent = processedContent.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  const plainContent = stripHtml(processedContent);
  drawBody(state, plainContent);

  // Certificate page
  newPage(state);
  drawHeading(state, 'Certificate of Completion');
  drawDivider(state);
  drawLabelValue(state, 'Document', 'Masai School — Internship Offer Letter');
  drawLabelValue(state, 'Signer name', 'Rahul Sharma');
  drawLabelValue(state, 'Signer email', 'rahul.sharma@example.com');
  drawLabelValue(state, 'Signed at', signedAt.toUTCString());
  drawLabelValue(state, 'IP address', '203.0.113.42');
  state.y -= 8;
  state.page.drawText('Field values:', { x: MARGIN, y: state.y - BODY_SIZE, size: BODY_SIZE, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
  state.y -= LINE_HEIGHT_BODY;
  for (const [key, value] of Object.entries(sampleFieldValues)) {
    drawLabelValue(state, `  ${key}`, value);
  }

  // Signature (typed style on canvas-like area)
  state.y -= 16;
  ensureSpace(state, 80);
  state.page.drawText('Signature:', { x: MARGIN, y: state.y - BODY_SIZE, size: BODY_SIZE, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
  state.y -= LINE_HEIGHT_BODY + 8;
  // Draw a signature box
  state.page.drawRectangle({ x: MARGIN, y: state.y - 60, width: 280, height: 60, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1, color: rgb(0.98, 0.98, 1) });
  state.page.drawText('Rahul Sharma', { x: MARGIN + 16, y: state.y - 42, size: 26, font: font, color: rgb(0.05, 0.05, 0.35) });
  state.y -= 72;

  drawDivider(state);
  drawBody(state, 'This certificate was generated automatically by MailFlow and serves as an audit record of the signing event.');

  const pdfBytes = await doc.save();
  const outPath = join(__dirname, 'sample-signed.pdf');
  writeFileSync(outPath, pdfBytes);
  console.log('Sample PDF written to:', outPath);
}

run().catch(console.error);
