import { PDFDocument, PDFFont, rgb, StandardFonts } from 'pdf-lib';
import {
  extractSigningVariables,
  labelForSigningField,
  publicSigningFieldValues,
  renderSigningContent,
} from '@/lib/signing/fields';
import {
  parseSignatureToken,
  signatureTokenRegex,
  type SignatureAlign,
  type SignatureSlot,
} from '@/lib/signing/signature-tokens';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface SignedPdfSignature {
  signerName: string;
  signerEmail: string;
  signerRole: string;
  signatureImage: string;
  signedAt: Date;
  signerIp: string;
  signerOrder: number;
}

export interface SignedPdfInput {
  title: string;
  content: string;
  recipientName: string;
  recipientEmail: string;
  fieldValues: Record<string, string>;
  signatureImage: string; // base64 data-URL or raw base64
  signedAt: Date;
  signerIp: string;
  additionalSignatures?: SignedPdfSignature[];
  /** Signatures drawn inline where the content has [[signature]] tokens. */
  signatureSlots?: SignatureSlot[];
  /** Unsigned preview: no certificate page, blank fields shown as [Label]. */
  preview?: boolean;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

type Align = 'left' | 'center' | 'right';

type BlockKind = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'hr' | 'li';

interface Block {
  kind: BlockKind;
  align: Align;
  indent: number; // left-indent in points (e.g. for list items)
  runs: Run[];
}

interface Fonts {
  reg: PDFFont;
  bold: PDFFont;
  ital: PDFFont;
  boldItal: PDFFont;
}

interface DrawState {
  doc: PDFDocument;
  fonts: Fonts;
  page: ReturnType<PDFDocument['addPage']>;
  y: number;
}

// ─── Page constants ───────────────────────────────────────────────────────────

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 55;
const USABLE_W = PAGE_W - MARGIN * 2;

const BODY_SZ = 10.5;
const BODY_LH = 15.5; // line height (baseline-to-baseline)

// ─── WinAnsi sanitizer ────────────────────────────────────────────────────────

function san(text: string): string {
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

// ─── HTML entity decoder ──────────────────────────────────────────────────────

function decodeEntities(t: string): string {
  return t
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, '');
}

// ─── HTML → Block parser ──────────────────────────────────────────────────────

function parseHtml(html: string): Block[] {
  html = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  const blocks: Block[] = [];
  let current: Block | null = null;
  let boldDepth = 0;
  let italicDepth = 0;
  let currentAlign: Align = 'left';
  let currentKind: BlockKind = 'p';
  let currentIndent = 0;

  function alignFromAttrs(attrs: string): Align | null {
    const m = /text-align\s*:\s*(left|center|right)/i.exec(attrs);
    return m ? (m[1]!.toLowerCase() as Align) : null;
  }

  function ensureBlock() {
    if (!current) {
      current = { kind: currentKind, align: currentAlign, indent: currentIndent, runs: [] };
    }
  }

  function pushText(text: string) {
    if (!text) return;
    ensureBlock();
    const bold = boldDepth > 0;
    const italic = italicDepth > 0;
    const last = current!.runs.at(-1);
    if (last && last.bold === bold && last.italic === italic) {
      last.text += text;
    } else {
      current!.runs.push({ text, bold, italic });
    }
  }

  function flushBlock() {
    if (current?.runs.some((r) => r.text.trim())) blocks.push(current!);
    current = null;
  }

  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>'"]*|'[^']*'|"[^"]*")*)\s*\/?>/g;
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > cursor) {
      pushText(decodeEntities(html.slice(cursor, m.index)));
    }
    cursor = m.index + m[0].length;

    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    const attrs = m[3] ?? '';

    if (closing) {
      switch (tag) {
        case 'p':
        case 'div':
          flushBlock();
          currentAlign = 'left';
          currentKind = 'p';
          break;
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          flushBlock();
          currentAlign = 'left';
          currentKind = 'p';
          break;
        case 'center':
          flushBlock();
          currentAlign = 'left';
          break;
        case 'li':
          flushBlock();
          currentIndent = 0;
          currentKind = 'p';
          break;
        case 'strong': case 'b': boldDepth = Math.max(0, boldDepth - 1); break;
        case 'em':     case 'i': italicDepth = Math.max(0, italicDepth - 1); break;
      }
    } else {
      const tagAlign = alignFromAttrs(attrs);
      switch (tag) {
        case 'br':
          pushText('\n');
          break;
        case 'hr':
          flushBlock();
          blocks.push({ kind: 'hr', align: 'left', indent: 0, runs: [] });
          break;
        case 'p':
          flushBlock();
          currentAlign = tagAlign ?? 'left';
          currentKind = 'p';
          break;
        case 'div':
          flushBlock();
          currentAlign = tagAlign ?? currentAlign;
          currentKind = 'p';
          break;
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          flushBlock();
          currentKind = tag as BlockKind;
          currentAlign = tagAlign ?? 'left';
          break;
        case 'center':
          flushBlock();
          currentAlign = 'center';
          currentKind = 'p';
          break;
        case 'li':
          flushBlock();
          currentKind = 'li';
          currentIndent = 16;
          pushText('• ');
          break;
        case 'strong': case 'b': boldDepth++; break;
        case 'em':     case 'i': italicDepth++; break;
      }
    }
  }

  if (cursor < html.length) pushText(decodeEntities(html.slice(cursor)));
  flushBlock();

  return blocks;
}

// ─── Block metrics ────────────────────────────────────────────────────────────

function blockFontSize(kind: BlockKind): number {
  switch (kind) {
    case 'h1': return 15;
    case 'h2': return 13;
    case 'h3': return 12;
    case 'h4': return 11.5;
    default:   return BODY_SZ;
  }
}

function blockLineHeight(kind: BlockKind): number {
  switch (kind) {
    case 'h1': return 22;
    case 'h2': return 19;
    case 'h3': return 18;
    case 'h4': return 17;
    default:   return BODY_LH;
  }
}

function blockSpaceBefore(kind: BlockKind): number {
  switch (kind) {
    case 'h1': return 10;
    case 'h2': return 8;
    case 'h3': case 'h4': return 6;
    default:   return 3;
  }
}

function blockSpaceAfter(kind: BlockKind): number {
  switch (kind) {
    case 'h1': return 5;
    case 'h2': return 4;
    default:   return 1;
  }
}

function isHeadingKind(kind: BlockKind): boolean {
  return kind === 'h1' || kind === 'h2' || kind === 'h3' || kind === 'h4' || kind === 'h5' || kind === 'h6';
}

// ─── Word-level line wrapping with mixed bold/italic ─────────────────────────

interface Segment { text: string; bold: boolean; italic: boolean; }
type VisualLine = Segment[];

function pickFont(fonts: Fonts, bold: boolean, italic: boolean): PDFFont {
  if (bold && italic) return fonts.boldItal;
  if (bold)           return fonts.bold;
  if (italic)         return fonts.ital;
  return fonts.reg;
}

function wrapBlockToLines(block: Block, fonts: Fonts): VisualLine[] {
  const sz = blockFontSize(block.kind);
  const forceB = isHeadingKind(block.kind);
  const maxW = USABLE_W - block.indent;

  // Tokenise runs into words (keeping trailing spaces) and explicit newlines
  interface WordTok { word: string; bold: boolean; italic: boolean; isBreak: boolean; }
  const tokens: WordTok[] = [];

  for (const run of block.runs) {
    const bold = run.bold || forceB;
    const italic = run.italic;
    const parts = run.text.split('\n');
    for (let pi = 0; pi < parts.length; pi++) {
      if (pi > 0) tokens.push({ word: '', bold, italic, isBreak: true });
      const words = parts[pi]!.match(/\S+\s*|\s+/g) ?? [];
      for (const w of words) tokens.push({ word: w, bold, italic, isBreak: false });
    }
  }

  const lines: VisualLine[] = [];
  let curLine: Segment[] = [];
  let curW = 0;

  function flushLine() {
    if (curLine.length === 0) return;
    const last = curLine[curLine.length - 1]!;
    last.text = last.text.trimEnd();
    if (curLine.some((s) => s.text.length > 0)) lines.push([...curLine]);
    curLine = [];
    curW = 0;
  }

  for (const tok of tokens) {
    if (tok.isBreak) { flushLine(); continue; }

    const safeWord = san(tok.word);
    const f = pickFont(fonts, tok.bold, tok.italic);
    const w = f.widthOfTextAtSize(safeWord, sz);

    // Skip pure-whitespace tokens at the very start of a new line
    if (curLine.length === 0 && !safeWord.trim()) continue;

    if (curW + w > maxW && curLine.length > 0) flushLine();

    const last = curLine[curLine.length - 1];
    if (last && last.bold === tok.bold && last.italic === tok.italic) {
      last.text += tok.word;
    } else {
      curLine.push({ text: tok.word, bold: tok.bold, italic: tok.italic });
    }
    curW += w;
  }
  flushLine();

  return lines;
}

// ─── Page management ──────────────────────────────────────────────────────────

function newPage(s: DrawState): void {
  s.page = s.doc.addPage([PAGE_W, PAGE_H]);
  s.y = PAGE_H - MARGIN;
}

function ensureSpace(s: DrawState, needed: number): void {
  if (s.y - needed < MARGIN) newPage(s);
}

// ─── Block renderer ───────────────────────────────────────────────────────────

function drawBlock(s: DrawState, block: Block): void {
  if (block.kind === 'hr') {
    ensureSpace(s, 20);
    s.y -= 10;
    s.page.drawLine({
      start: { x: MARGIN, y: s.y },
      end:   { x: PAGE_W - MARGIN, y: s.y },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
    s.y -= 10;
    return;
  }

  const sz = blockFontSize(block.kind);
  const lh = blockLineHeight(block.kind);
  const lines = wrapBlockToLines(block, s.fonts);
  if (lines.length === 0) return;

  s.y -= blockSpaceBefore(block.kind);

  for (const line of lines) {
    ensureSpace(s, lh);

    // Compute total line width for alignment
    let lineW = 0;
    for (const seg of line) {
      lineW += pickFont(s.fonts, seg.bold, seg.italic).widthOfTextAtSize(san(seg.text), sz);
    }

    const baseX = MARGIN + block.indent;
    let x =
      block.align === 'center' ? (PAGE_W - lineW) / 2 :
      block.align === 'right'  ? PAGE_W - MARGIN - lineW :
      baseX;

    // Descend to baseline
    s.y -= sz;

    for (const seg of line) {
      const safeText = san(seg.text);
      if (!safeText) continue;
      const f = pickFont(s.fonts, seg.bold, seg.italic);
      s.page.drawText(safeText, {
        x, y: s.y, size: sz, font: f, color: rgb(0.08, 0.08, 0.08),
      });
      x += f.widthOfTextAtSize(safeText, sz);
    }

    s.y -= lh - sz; // gap below baseline
  }

  s.y -= blockSpaceAfter(block.kind);
}

// Helper for simple single-run blocks
function block(
  kind: BlockKind,
  text: string,
  opts: { bold?: boolean; italic?: boolean; align?: Align; indent?: number } = {}
): Block {
  return {
    kind,
    align:  opts.align  ?? 'left',
    indent: opts.indent ?? 0,
    runs: [{ text, bold: opts.bold ?? false, italic: opts.italic ?? false }],
  };
}

// ─── Inline signature slots ───────────────────────────────────────────────────

const SIG_MARK_RE = /@@SIG_([1-3])_(left|center|right)@@/g;

type ContentPiece = { type: 'block'; block: Block } | { type: 'sig'; signerIndex: number; align: SignatureAlign };

/** Splits blocks at signature markers so a slot can be drawn between text. */
function splitAtSignatureMarks(blocks: Block[]): ContentPiece[] {
  const out: ContentPiece[] = [];
  for (const blk of blocks) {
    let current: Block = { ...blk, runs: [] };
    let sawMark = false;
    for (const run of blk.runs) {
      let last = 0;
      for (const m of run.text.matchAll(SIG_MARK_RE)) {
        sawMark = true;
        const before = run.text.slice(last, m.index);
        if (before) current.runs.push({ ...run, text: before });
        if (current.runs.some((r) => r.text.trim())) out.push({ type: 'block', block: current });
        out.push({ type: 'sig', signerIndex: Number(m[1]), align: m[2] as SignatureAlign });
        current = { ...blk, runs: [] };
        last = (m.index ?? 0) + m[0].length;
      }
      const rest = run.text.slice(last);
      if (rest) current.runs.push({ ...run, text: rest });
    }
    if (!sawMark) out.push({ type: 'block', block: blk });
    else if (current.runs.some((r) => r.text.trim())) out.push({ type: 'block', block: current });
  }
  return out;
}

function rawPng(image: string): string {
  return image.startsWith('data:') ? image.replace(/^data:image\/png;base64,/, '') : image;
}

async function drawSignatureSlot(
  s: DrawState,
  align: SignatureAlign,
  signerIndex: number,
  slot: SignatureSlot | undefined,
  preview: boolean,
): Promise<void> {
  const BOX_W = 200;
  const IMG_MAX_H = 50;
  ensureSpace(s, IMG_MAX_H + 50);
  s.y -= 10;
  const x = align === 'center' ? (PAGE_W - BOX_W) / 2 : align === 'right' ? PAGE_W - MARGIN - BOX_W : MARGIN;
  const top = s.y;
  const label = slot?.role || `Signer ${signerIndex}`;

  let drewImage = false;
  if (slot?.image) {
    try {
      const png = await s.doc.embedPng(Buffer.from(rawPng(slot.image), 'base64'));
      const { width: iw, height: ih } = png.scale(1);
      const scale = Math.min(BOX_W / iw, IMG_MAX_H / ih, 1);
      s.page.drawImage(png, { x, y: top - ih * scale, width: iw * scale, height: ih * scale });
      drewImage = true;
    } catch {
      drewImage = false;
    }
  }
  if (!drewImage) {
    s.page.drawText(san(preview ? `${label} signs here` : 'Awaiting signature'), {
      x: x + 4, y: top - 32, size: 9, font: s.fonts.ital, color: rgb(0.6, 0.6, 0.6),
    });
  }

  s.y = top - IMG_MAX_H - 4;
  s.page.drawLine({ start: { x, y: s.y }, end: { x: x + BOX_W, y: s.y }, thickness: 0.8, color: rgb(0.45, 0.45, 0.45) });
  s.y -= 11;
  const caption = san(`${label}${slot?.name ? ` - ${slot.name}` : ''}`);
  s.page.drawText(caption, { x, y: s.y, size: 8.5, font: s.fonts.bold, color: rgb(0.2, 0.2, 0.2) });
  if (drewImage && slot?.signedAt) {
    s.y -= 10;
    const when = typeof slot.signedAt === 'string' ? new Date(slot.signedAt) : slot.signedAt;
    s.page.drawText(san(`Signed: ${when.toUTCString()}`), { x, y: s.y, size: 7.5, font: s.fonts.reg, color: rgb(0.45, 0.45, 0.45) });
  }
  s.y -= 14;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateSignedPdf(input: SignedPdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    reg:      await doc.embedFont(StandardFonts.Helvetica),
    bold:     await doc.embedFont(StandardFonts.HelveticaBold),
    ital:     await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItal: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  const s: DrawState = {
    doc, fonts,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: PAGE_H - MARGIN,
  };

  // ── Document header ──────────────────────────────────────────────────────────
  drawBlock(s, block('h1', san(input.title), { bold: true }));
  drawBlock(s, { kind: 'hr', align: 'left', indent: 0, runs: [] });

  const signedDateStr = input.signedAt.toUTCString();
  if (input.preview) {
    drawBlock(s, block('p', 'PREVIEW - NOT SIGNED', { bold: true }));
    drawBlock(s, block('p', `Prepared for: ${input.recipientName}${input.recipientEmail ? ` <${input.recipientEmail}>` : ''}. Fields in [brackets] are completed by the signer.`, { italic: true }));
  } else {
    drawBlock(s, {
      kind: 'p', align: 'left', indent: 0,
      runs: [
        { text: 'Signed by: ', bold: true, italic: false },
        { text: `${input.recipientName} <${input.recipientEmail}>`, bold: false, italic: false },
      ],
    });
    drawBlock(s, {
      kind: 'p', align: 'left', indent: 0,
      runs: [
        { text: 'Signed on: ', bold: true, italic: false },
        { text: signedDateStr, bold: false, italic: false },
      ],
    });
  }
  drawBlock(s, { kind: 'hr', align: 'left', indent: 0, runs: [] });

  // ── Document content (HTML rendered, variables substituted) ──────────────────
  const publicValues = publicSigningFieldValues(input.fieldValues);
  const renderValues = { ...publicValues };
  if (input.preview) {
    for (const key of extractSigningVariables(input.content)) {
      if (!(renderValues[key] ?? '').trim()) renderValues[key] = `[${labelForSigningField(key)}]`;
    }
  }
  const processedContent = renderSigningContent(input.content, renderValues)
    .replace(/\{\{\w+\}\}/g, '')
    .replace(signatureTokenRegex(), (_m, signer?: string, align?: string) => {
      const tok = parseSignatureToken(signer, align);
      return ` @@SIG_${tok.signerIndex}_${tok.align}@@ `;
    });

  const slotsBySigner = new Map((input.signatureSlots ?? []).map((slot) => [slot.signerIndex, slot]));
  for (const piece of splitAtSignatureMarks(parseHtml(processedContent))) {
    if (piece.type === 'block') drawBlock(s, piece.block);
    else await drawSignatureSlot(s, piece.align, piece.signerIndex, slotsBySigner.get(piece.signerIndex), !!input.preview);
  }

  if (input.preview) return Buffer.from(await doc.save());

  // ── Certificate of completion (new page) ─────────────────────────────────────
  newPage(s);

  drawBlock(s, block('h2', 'Certificate of Completion', { bold: true }));
  drawBlock(s, { kind: 'hr', align: 'left', indent: 0, runs: [] });

  // Build the list of all signers for the certificate
  const allSigners: { name: string; email: string; role: string; signedAt: string; ip: string; signatureImage: string }[] =
    input.additionalSignatures?.length
      ? input.additionalSignatures
          .sort((a, b) => a.signerOrder - b.signerOrder)
          .map((sig) => ({
            name: sig.signerName,
            email: sig.signerEmail,
            role: sig.signerRole,
            signedAt: sig.signedAt.toUTCString(),
            ip: sig.signerIp,
            signatureImage: sig.signatureImage,
          }))
      : [{
          name: input.recipientName,
          email: input.recipientEmail,
          role: '',
          signedAt: signedDateStr,
          ip: input.signerIp,
          signatureImage: input.signatureImage,
        }];

  drawBlock(s, {
    kind: 'p', align: 'left', indent: 0,
    runs: [
      { text: 'Document: ', bold: true, italic: false },
      { text: san(input.title), bold: false, italic: false },
    ],
  });

  if (allSigners.length > 1) {
    drawBlock(s, block('p', `Total signers: ${allSigners.length}`, { bold: false }));
  }
  s.y -= 4;

  for (let si = 0; si < allSigners.length; si++) {
    const signer = allSigners[si]!;
    if (allSigners.length > 1) {
      s.y -= 6;
      drawBlock(s, block('h3', `Signer ${si + 1}${signer.role ? ` - ${signer.role}` : ''}`, { bold: true }));
    }

    const rows: [string, string][] = [
      ['Name', signer.name],
      ['Email', signer.email],
      ...(signer.role ? [['Role', signer.role] as [string, string]] : []),
      ['Signed at', signer.signedAt],
      ['IP address', signer.ip],
    ];

    for (const [label, value] of rows) {
      drawBlock(s, {
        kind: 'p', align: 'left', indent: allSigners.length > 1 ? 12 : 0,
        runs: [
          { text: `${label}: `, bold: true, italic: false },
          { text: san(value), bold: false, italic: false },
        ],
      });
    }

    // Embed signature image
    const rawSig = signer.signatureImage.startsWith('data:')
      ? signer.signatureImage.replace(/^data:image\/png;base64,/, '')
      : signer.signatureImage;

    if (rawSig) {
      try {
        const pngBytes = Buffer.from(rawSig, 'base64');
        const pngImage = await doc.embedPng(pngBytes);
        const maxW = USABLE_W - (allSigners.length > 1 ? 12 : 0);
        const maxH = 80;
        const { width: iw, height: ih } = pngImage.scale(1);
        const scale = Math.min(maxW / iw, maxH / ih, 1);
        const drawW = iw * scale;
        const drawH = ih * scale;

        ensureSpace(s, drawH + 40);
        s.y -= 8;
        drawBlock(s, block('p', 'Signature:', { bold: true }));
        s.y -= 4;
        s.page.drawImage(pngImage, {
          x: MARGIN + (allSigners.length > 1 ? 12 : 0),
          y: s.y - drawH,
          width: drawW,
          height: drawH,
        });
        s.y -= drawH + 10;
      } catch {
        drawBlock(s, block('p', '[Signature image could not be embedded]', { italic: true }));
      }
    }
  }

  if (Object.keys(publicValues).length > 0) {
    s.y -= 6;
    drawBlock(s, block('p', 'Field values:', { bold: true }));
    for (const [key, value] of Object.entries(publicValues)) {
      drawBlock(s, {
        kind: 'p', align: 'left', indent: 16,
        runs: [
          { text: `${key}: `, bold: true, italic: false },
          { text: san(String(value)), bold: false, italic: false },
        ],
      });
    }
  }

  drawBlock(s, { kind: 'hr', align: 'left', indent: 0, runs: [] });
  drawBlock(s, block('p', 'This certificate was generated automatically by MailFlow and serves as an audit record of the signing event.', { italic: false }));

  return Buffer.from(await doc.save());
}
