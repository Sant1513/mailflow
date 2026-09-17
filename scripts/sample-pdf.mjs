/**
 * Generates a sample signed PDF using the new HTML-aware renderer.
 * Run: node scripts/sample-pdf.mjs
 */
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ────────────────────────────────────────────────────────────────
const PAGE_W = 595, PAGE_H = 842, MARGIN = 55, USABLE_W = PAGE_W - MARGIN * 2;
const BODY_SZ = 10.5, BODY_LH = 15.5;

// ── WinAnsi sanitiser ─────────────────────────────────────────────────────────
function san(t) {
  return String(t)
    .replace(/₹/g, 'Rs.').replace(/€/g, 'EUR ').replace(/£/g, 'GBP ')
    .replace(/—/g, '--').replace(/–/g, '-')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/•/g, '*')
    .replace(/[^\x00-\xFF]/g, '?');
}

function decodeEntities(t) {
  return t.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&nbsp;/g,' ').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&#\d+;/g,'');
}

// ── HTML → Block parser ───────────────────────────────────────────────────────
function parseHtml(html) {
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'')
             .replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'');
  const blocks = [];
  let current = null, boldD = 0, italD = 0, curAlign = 'left', curKind = 'p', curIndent = 0;

  function alignFromAttrs(a) {
    const m = /text-align\s*:\s*(left|center|right)/i.exec(a);
    return m ? m[1].toLowerCase() : null;
  }
  function ensure() {
    if (!current) current = { kind: curKind, align: curAlign, indent: curIndent, runs: [] };
  }
  function push(text) {
    if (!text) return;
    ensure();
    const bold = boldD > 0, italic = italD > 0;
    const last = current.runs.at(-1);
    if (last && last.bold === bold && last.italic === italic) last.text += text;
    else current.runs.push({ text, bold, italic });
  }
  function flush() {
    if (current?.runs.some(r => r.text.trim())) blocks.push(current);
    current = null;
  }

  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>'"]*|'[^']*'|"[^"]*")*)\s*\/?>/g;
  let cursor = 0, m;
  while ((m = re.exec(html)) !== null) {
    if (m.index > cursor) push(decodeEntities(html.slice(cursor, m.index)));
    cursor = m.index + m[0].length;
    const closing = m[1] === '/', tag = m[2].toLowerCase(), attrs = m[3] ?? '';
    if (closing) {
      switch(tag) {
        case 'p': case 'div': flush(); curAlign='left'; curKind='p'; break;
        case 'h1':case 'h2':case 'h3':case 'h4':case 'h5':case 'h6':
          flush(); curAlign='left'; curKind='p'; break;
        case 'center': flush(); curAlign='left'; break;
        case 'li': flush(); curIndent=0; curKind='p'; break;
        case 'strong':case 'b': boldD=Math.max(0,boldD-1); break;
        case 'em':case 'i': italD=Math.max(0,italD-1); break;
      }
    } else {
      const ta = alignFromAttrs(attrs);
      switch(tag) {
        case 'br': push('\n'); break;
        case 'hr': flush(); blocks.push({kind:'hr',align:'left',indent:0,runs:[]}); break;
        case 'p': flush(); curAlign=ta??'left'; curKind='p'; break;
        case 'div': flush(); curAlign=ta??curAlign; curKind='p'; break;
        case 'h1':case 'h2':case 'h3':case 'h4':case 'h5':case 'h6':
          flush(); curKind=tag; curAlign=ta??'left'; break;
        case 'center': flush(); curAlign='center'; curKind='p'; break;
        case 'li': flush(); curKind='li'; curIndent=16; push('• '); break;
        case 'strong':case 'b': boldD++; break;
        case 'em':case 'i': italD++; break;
      }
    }
  }
  if (cursor < html.length) push(decodeEntities(html.slice(cursor)));
  flush();
  return blocks;
}

// ── Block metrics ─────────────────────────────────────────────────────────────
function bSz(k) { return k==='h1'?15:k==='h2'?13:k==='h3'?12:k==='h4'?11.5:BODY_SZ; }
function bLh(k) { return k==='h1'?22:k==='h2'?19:k==='h3'?18:k==='h4'?17:BODY_LH; }
function bBefore(k) { return k==='h1'?10:k==='h2'?8:(k==='h3'||k==='h4')?6:3; }
function bAfter(k) { return k==='h1'?5:k==='h2'?4:1; }
function isH(k) { return ['h1','h2','h3','h4','h5','h6'].includes(k); }

// ── Line wrapping ─────────────────────────────────────────────────────────────
function pickFont(fonts, bold, italic) {
  return bold&&italic ? fonts.bi : bold ? fonts.b : italic ? fonts.i : fonts.r;
}

function wrapBlock(block, fonts) {
  const sz = bSz(block.kind), forceB = isH(block.kind), maxW = USABLE_W - block.indent;
  const tokens = [];
  for (const run of block.runs) {
    const bold = run.bold || forceB, italic = run.italic;
    const parts = run.text.split('\n');
    for (let pi = 0; pi < parts.length; pi++) {
      if (pi > 0) tokens.push({ word:'', bold, italic, br:true });
      for (const w of (parts[pi].match(/\S+\s*|\s+/g)??[]))
        tokens.push({ word:w, bold, italic, br:false });
    }
  }

  const lines = []; let cur = [], curW = 0;
  function flush() {
    if (!cur.length) return;
    const last = cur[cur.length-1];
    last.text = last.text.trimEnd();
    if (cur.some(s => s.text)) lines.push([...cur]);
    cur=[]; curW=0;
  }
  for (const tok of tokens) {
    if (tok.br) { flush(); continue; }
    const sw = san(tok.word), f = pickFont(fonts, tok.bold, tok.italic);
    const w = f.widthOfTextAtSize(sw, sz);
    if (cur.length === 0 && !sw.trim()) continue;
    if (curW + w > maxW && cur.length > 0) flush();
    const last = cur[cur.length-1];
    if (last && last.bold===tok.bold && last.italic===tok.italic) last.text+=tok.word;
    else cur.push({text:tok.word, bold:tok.bold, italic:tok.italic});
    curW += w;
  }
  flush();
  return lines;
}

// ── Renderer ──────────────────────────────────────────────────────────────────
function newPage(s) { s.page = s.doc.addPage([PAGE_W,PAGE_H]); s.y = PAGE_H-MARGIN; }
function space(s, n) { if (s.y-n < MARGIN) newPage(s); }

function drawBlock(s, block) {
  if (block.kind === 'hr') {
    space(s,20); s.y-=10;
    s.page.drawLine({start:{x:MARGIN,y:s.y},end:{x:PAGE_W-MARGIN,y:s.y},thickness:0.5,color:rgb(0.7,0.7,0.7)});
    s.y-=10; return;
  }
  const sz = bSz(block.kind), lh = bLh(block.kind);
  const lines = wrapBlock(block, s.fonts);
  if (!lines.length) return;
  s.y -= bBefore(block.kind);
  for (const line of lines) {
    space(s, lh);
    let lw = 0;
    for (const seg of line) lw += pickFont(s.fonts,seg.bold,seg.italic).widthOfTextAtSize(san(seg.text),sz);
    let x = block.align==='center'?(PAGE_W-lw)/2:block.align==='right'?PAGE_W-MARGIN-lw:MARGIN+block.indent;
    s.y -= sz;
    for (const seg of line) {
      const st = san(seg.text);
      if (!st) continue;
      const f = pickFont(s.fonts,seg.bold,seg.italic);
      s.page.drawText(st,{x,y:s.y,size:sz,font:f,color:rgb(0.08,0.08,0.08)});
      x += f.widthOfTextAtSize(st,sz);
    }
    s.y -= lh-sz;
  }
  s.y -= bAfter(block.kind);
}

function bk(kind, text, {bold=false,italic=false,align='left',indent=0}={}) {
  return {kind,align,indent,runs:[{text,bold,italic}]};
}

// ── Sample document ───────────────────────────────────────────────────────────
const sampleContent = `
<h2 style="text-align:center;">ADDENDUM TO THE PAY AFTER PLACEMENT AGREEMENT</h2>

<p style="text-align:center;">This addendum is entered into between:</p>

<p><strong>Masai School</strong> (hereinafter referred to as the "Institute"), a company incorporated under the laws of India, with its registered office at Bangalore, Karnataka,</p>

<p style="text-align:center;"><strong>AND</strong></p>

<p><strong>Abhishesh Kumar</strong> (hereinafter referred to as the "Student"),<br/>Email: abhishesh.kumar@masaischool.com<br/>Student ID: MS2026042</p>

<hr/>

<h3>1. Purpose</h3>

<p>This Addendum supplements and modifies the Pay After Placement Agreement (the "Principal Agreement") previously executed between the Institute and the Student. All terms not modified herein shall remain in full force and effect as per the Principal Agreement.</p>

<h3>2. Modified Stipend Structure</h3>

<p>Notwithstanding anything contained in the Principal Agreement, the parties hereby agree to the following revised stipend structure during the training period:</p>

<ul>
  <li>Monthly stipend during training: <strong>Rs. 5,000</strong></li>
  <li>Stipend commencement date: <strong>1st October 2026</strong></li>
  <li>Duration of modified stipend: <strong>6 months</strong></li>
</ul>

<h3>3. Income Share Agreement — Revised Terms</h3>

<p>Upon successful placement at a CTC of <strong>Rs. 5,00,000 per annum or above</strong>, the Student agrees to pay the Institute <strong>15% of monthly gross salary</strong> for a period of <strong>24 months</strong>, subject to a maximum of <strong>Rs. 3,00,000</strong> in aggregate.</p>

<p>In the event the CTC is below Rs. 5,00,000 per annum, the income share obligation shall be <strong>deferred</strong> until the Student secures qualifying employment.</p>

<h3>4. Governing Law</h3>

<p>This Addendum shall be governed by and construed in accordance with the laws of India. Any disputes arising hereunder shall be subject to the exclusive jurisdiction of courts in <strong>Bangalore, Karnataka</strong>.</p>

<p style="text-align:center;"><em>By signing this document electronically, the Student acknowledges having read, understood, and agreed to all the terms set forth in this Addendum.</em></p>
`;

async function run() {
  const doc = await PDFDocument.create();
  const fonts = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
    bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const s = { doc, fonts, page: doc.addPage([PAGE_W,PAGE_H]), y: PAGE_H-MARGIN };

  // Header
  drawBlock(s, bk('h1', 'Masai School — Pay After Placement Agreement', {bold:true}));
  drawBlock(s, {kind:'hr',align:'left',indent:0,runs:[]});
  drawBlock(s, {kind:'p',align:'left',indent:0,runs:[
    {text:'Signed by: ',bold:true,italic:false},
    {text:'Abhishesh Kumar <abhishesh.kumar@masaischool.com>',bold:false,italic:false},
  ]});
  drawBlock(s, {kind:'p',align:'left',indent:0,runs:[
    {text:'Signed on: ',bold:true,italic:false},
    {text:new Date('2026-09-17T10:08:06Z').toUTCString(),bold:false,italic:false},
  ]});
  drawBlock(s, {kind:'hr',align:'left',indent:0,runs:[]});

  // Document content
  for (const block of parseHtml(sampleContent)) drawBlock(s, block);

  // Certificate page
  newPage(s);
  drawBlock(s, bk('h2','Certificate of Completion',{bold:true}));
  drawBlock(s, {kind:'hr',align:'left',indent:0,runs:[]});
  for (const [label, value] of [
    ['Document','Masai School — Pay After Placement Agreement'],
    ['Signer name','Abhishesh Kumar'],
    ['Signer email','abhishesh.kumar@masaischool.com'],
    ['Signed at',new Date('2026-09-17T10:08:06Z').toUTCString()],
    ['IP address','203.0.113.42'],
  ]) {
    drawBlock(s, {kind:'p',align:'left',indent:0,runs:[
      {text:`${label}: `,bold:true,italic:false},
      {text:san(value),bold:false,italic:false},
    ]});
  }

  s.y -= 8;
  drawBlock(s, bk('p','Field values:',{bold:true}));
  for (const [k,v] of Object.entries({student_name:'Abhishesh Kumar',student_id:'MS2026042',stipend:'Rs. 5,000/month',start_date:'1st October 2026'})) {
    drawBlock(s, {kind:'p',align:'left',indent:16,runs:[
      {text:`${k}: `,bold:true,italic:false},{text:san(v),bold:false,italic:false}
    ]});
  }

  // Fake signature box (no real PNG in sample)
  space(s, 120); s.y -= 14;
  drawBlock(s, bk('p','Signature:',{bold:true}));
  s.y -= 4;
  s.page.drawRectangle({x:MARGIN,y:s.y-70,width:260,height:70,borderColor:rgb(0.8,0.8,0.8),borderWidth:1,color:rgb(0.97,0.97,1)});
  s.page.drawText('Abhishesh Kumar', {x:MARGIN+12,y:s.y-48,size:24,font:fonts.i,color:rgb(0.05,0.05,0.4)});
  s.y -= 82;

  drawBlock(s, {kind:'hr',align:'left',indent:0,runs:[]});
  drawBlock(s, bk('p','This certificate was generated automatically by MailFlow and serves as an audit record of the signing event.'));

  const outPath = join(__dirname, 'sample-signed.pdf');
  writeFileSync(outPath, await doc.save());
  console.log('Written:', outPath);
}

run().catch(console.error);
