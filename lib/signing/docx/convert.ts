import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { cleanFontName, fontImports, fontStack, lineFactor } from './fonts';

/**
 * Word (.docx) → HTML with inline CSS that reproduces the document's own
 * formatting: fonts, sizes, colours, highlights, paragraph spacing, line
 * spacing, alignment, indents, tab stops, numbered and bulleted lists,
 * tables (column widths, borders, shading, merged cells), images, text
 * boxes, the page header / footer, and the page size and margins (so the
 * signed PDF paginates like Word). Google Docs are exported as .docx and go
 * through the same path.
 *
 * All output is generated here from parsed XML: text is escaped, colours and
 * sizes are numbers or validated hex, font names are cleaned, links are
 * http(s)/mailto only and images are embedded data URIs of image types.
 */

// ─── XML helpers ────────────────────────────────────────────────────────────

type El = Element;
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function kids(el: El | null | undefined, name?: string): El[] {
  const out: El[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || (n as El).localName === name)) out.push(n as El);
  }
  return out;
}
const kid = (el: El | null | undefined, name: string): El | null => kids(el, name)[0] ?? null;
function path(el: El | null | undefined, ...names: string[]): El | null {
  let cur: El | null | undefined = el;
  for (const n of names) cur = kid(cur, n);
  return cur ?? null;
}
function descendants(el: El, name: string): El[] {
  const out: El[] = [];
  const walk = (e: El) => {
    for (const c of kids(e)) {
      if (c.localName === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}
/** Attribute by local name, ignoring the relationships namespace (w:val, w:w …). */
function attr(el: El | null | undefined, name: string): string | null {
  if (!el?.attributes) return null;
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    if ((a.localName ?? a.name) === name && a.namespaceURI !== NS_R) return a.value;
  }
  return null;
}
function rAttr(el: El | null | undefined, name: string): string | null {
  if (!el?.attributes) return null;
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    if ((a.localName ?? a.name) === name && a.namespaceURI === NS_R) return a.value;
  }
  return null;
}
const num = (v: string | null | undefined): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
/** On/off properties: <w:b/> is on, <w:b w:val="0|false|off"/> is off. */
function onOff(el: El | null): boolean | undefined {
  if (!el) return undefined;
  const v = attr(el, 'val');
  return !(v === '0' || v === 'false' || v === 'off' || v === 'none');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = (v: string | null | undefined): string | undefined => (v && /^[0-9A-Fa-f]{6}$/.test(v) ? `#${v.toLowerCase()}` : undefined);
/** Twentieths of a point → CSS px. */
const twip = (v: number | undefined) => (v === undefined ? undefined : Math.round((v / 15) * 100) / 100);
const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── Properties ─────────────────────────────────────────────────────────────

interface RunProps {
  font?: string;
  size?: number; // pt
  bold?: boolean;
  italic?: boolean;
  underline?: string;
  strike?: boolean;
  dstrike?: boolean;
  color?: string;
  highlight?: string;
  shade?: string;
  vertAlign?: string;
  caps?: boolean;
  smallCaps?: boolean;
  spacing?: number; // px
  hidden?: boolean;
}

interface Border {
  style: string;
  width: number; // pt
  color: string;
  space: number; // pt
}

interface TabStop {
  val: string;
  pos: number; // px from the margin
  leader?: string;
}

interface ParaProps {
  align?: string;
  before?: number; // px
  after?: number;
  beforeAuto?: boolean;
  afterAuto?: boolean;
  line?: number;
  lineRule?: string;
  left?: number; // px
  right?: number;
  firstLine?: number;
  hanging?: number;
  numId?: string;
  ilvl?: number;
  pageBreakBefore?: boolean;
  contextual?: boolean;
  shade?: string;
  borders?: Partial<Record<'top' | 'bottom' | 'left' | 'right', Border | null>>;
  tabs?: TabStop[];
  keepNext?: boolean;
}

function merge<T extends object>(...layers: (Partial<T> | undefined)[]): T {
  const out: Record<string, unknown> = {};
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function mergePara(...layers: (ParaProps | undefined)[]): ParaProps {
  const out = merge<ParaProps>(...layers);
  // Borders and tab stops add up across styles rather than replace.
  const borders: ParaProps['borders'] = {};
  const tabs = new Map<number, TabStop>();
  for (const l of layers) {
    if (l?.borders) Object.assign(borders, l.borders);
    for (const t of l?.tabs ?? []) {
      if (t.val === 'clear') tabs.delete(t.pos);
      else tabs.set(t.pos, t);
    }
  }
  out.borders = borders;
  out.tabs = [...tabs.values()].sort((a, b) => a.pos - b.pos);
  return out;
}

const HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

function parseBorder(el: El | null): Border | null | undefined {
  if (!el) return undefined;
  const val = attr(el, 'val') ?? 'single';
  if (val === 'nil' || val === 'none') return null;
  const style = val === 'double' ? 'double' : /dot/.test(val) ? 'dotted' : /dash/.test(val) ? 'dashed' : 'solid';
  const width = Math.max(0.25, (num(attr(el, 'sz')) ?? 4) / 8);
  return { style, width: val === 'double' ? Math.max(width * 3, 2.25) : width, color: hex(attr(el, 'color')) ?? '#000000', space: num(attr(el, 'space')) ?? 0 };
}
const borderCss = (b: Border | null | undefined) => (b ? `${r2(b.width)}pt ${b.style} ${b.color}` : 'none');

interface Theme {
  major?: string;
  minor?: string;
}

function parseRPr(rPr: El | null, theme: Theme): RunProps {
  if (!rPr) return {};
  const p: RunProps = {};
  const fonts = kid(rPr, 'rFonts');
  if (fonts) {
    const themed = attr(fonts, 'asciiTheme') ?? attr(fonts, 'hAnsiTheme');
    const fromTheme = themed ? (/^major/.test(themed) ? theme.major : theme.minor) : undefined;
    p.font = attr(fonts, 'ascii') ?? attr(fonts, 'hAnsi') ?? fromTheme ?? attr(fonts, 'cs') ?? attr(fonts, 'eastAsia') ?? undefined;
  }
  const sz = num(attr(kid(rPr, 'sz'), 'val'));
  if (sz) p.size = sz / 2;
  p.bold = onOff(kid(rPr, 'b'));
  p.italic = onOff(kid(rPr, 'i'));
  const u = kid(rPr, 'u');
  if (u) p.underline = attr(u, 'val') ?? 'single';
  p.strike = onOff(kid(rPr, 'strike'));
  p.dstrike = onOff(kid(rPr, 'dstrike'));
  const color = kid(rPr, 'color');
  if (color) p.color = attr(color, 'val') === 'auto' ? '#000000' : hex(attr(color, 'val'));
  const hl = attr(kid(rPr, 'highlight'), 'val');
  if (hl) p.highlight = hl === 'none' ? 'transparent' : HIGHLIGHT[hl];
  const shd = attr(kid(rPr, 'shd'), 'fill');
  if (shd) p.shade = hex(shd);
  const va = attr(kid(rPr, 'vertAlign'), 'val');
  if (va) p.vertAlign = va;
  p.caps = onOff(kid(rPr, 'caps'));
  p.smallCaps = onOff(kid(rPr, 'smallCaps'));
  const sp = num(attr(kid(rPr, 'spacing'), 'val'));
  if (sp !== undefined) p.spacing = twip(sp);
  p.hidden = onOff(kid(rPr, 'vanish'));
  return p;
}

function parsePPr(pPr: El | null): ParaProps {
  if (!pPr) return {};
  const p: ParaProps = {};
  const jc = attr(kid(pPr, 'jc'), 'val');
  if (jc) p.align = jc;
  const sp = kid(pPr, 'spacing');
  if (sp) {
    p.before = twip(num(attr(sp, 'before')));
    p.after = twip(num(attr(sp, 'after')));
    const isOn = (v: string | null) => v === '1' || v === 'true' || v === 'on';
    if (isOn(attr(sp, 'beforeAutospacing'))) p.beforeAuto = true;
    if (isOn(attr(sp, 'afterAutospacing'))) p.afterAuto = true;
    p.line = num(attr(sp, 'line'));
    p.lineRule = attr(sp, 'lineRule') ?? (p.line !== undefined ? 'auto' : undefined);
  }
  const ind = kid(pPr, 'ind');
  if (ind) {
    p.left = twip(num(attr(ind, 'left') ?? attr(ind, 'start')));
    p.right = twip(num(attr(ind, 'right') ?? attr(ind, 'end')));
    p.firstLine = twip(num(attr(ind, 'firstLine')));
    p.hanging = twip(num(attr(ind, 'hanging')));
    if (p.hanging !== undefined) p.firstLine = undefined;
    if (p.firstLine !== undefined) p.hanging = undefined;
  }
  const numPr = kid(pPr, 'numPr');
  if (numPr) {
    const id = attr(kid(numPr, 'numId'), 'val');
    if (id !== null) p.numId = id;
    const lvl = num(attr(kid(numPr, 'ilvl'), 'val'));
    if (lvl !== undefined) p.ilvl = lvl;
  }
  p.pageBreakBefore = onOff(kid(pPr, 'pageBreakBefore'));
  p.contextual = onOff(kid(pPr, 'contextualSpacing'));
  p.keepNext = onOff(kid(pPr, 'keepNext'));
  const shd = attr(kid(pPr, 'shd'), 'fill');
  if (shd) p.shade = hex(shd);
  const bdr = kid(pPr, 'pBdr');
  if (bdr) {
    p.borders = {};
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const b = parseBorder(kid(bdr, side));
      if (b !== undefined) p.borders[side] = b;
    }
  }
  const tabs = kid(pPr, 'tabs');
  if (tabs) {
    p.tabs = kids(tabs, 'tab').map((t) => ({ val: attr(t, 'val') ?? 'left', pos: twip(num(attr(t, 'pos'))) ?? 0, leader: attr(t, 'leader') ?? undefined }));
  }
  return p;
}

// ─── Styles and numbering ───────────────────────────────────────────────────

interface StyleDef {
  type: string;
  basedOn?: string;
  p: ParaProps;
  r: RunProps;
  tblBorders?: Record<string, Border | null | undefined>;
  cellMar?: Record<string, number | undefined>;
}

interface Styles {
  defaults: { p: ParaProps; r: RunProps };
  byId: Map<string, StyleDef>;
  defaultPara?: string;
  defaultTable?: string;
}

function parseTblBorders(el: El | null) {
  if (!el) return undefined;
  const out: Record<string, Border | null | undefined> = {};
  for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV', 'start', 'end']) {
    const b = parseBorder(kid(el, side));
    if (b !== undefined) out[side === 'start' ? 'left' : side === 'end' ? 'right' : side] = b;
  }
  return out;
}
function parseCellMar(el: El | null) {
  if (!el) return undefined;
  const out: Record<string, number | undefined> = {};
  for (const side of ['top', 'left', 'bottom', 'right', 'start', 'end']) {
    const w = twip(num(attr(kid(el, side), 'w')));
    if (w !== undefined) out[side === 'start' ? 'left' : side === 'end' ? 'right' : side] = w;
  }
  return out;
}

function parseStyles(doc: Document | null, theme: Theme): Styles {
  const styles: Styles = { defaults: { p: {}, r: {} }, byId: new Map() };
  const root = doc?.documentElement ?? null;
  const dd = kid(root, 'docDefaults');
  styles.defaults.r = parseRPr(path(dd, 'rPrDefault', 'rPr'), theme);
  styles.defaults.p = parsePPr(path(dd, 'pPrDefault', 'pPr'));
  for (const s of kids(root, 'style')) {
    const id = attr(s, 'styleId');
    if (!id) continue;
    const type = attr(s, 'type') ?? 'paragraph';
    const tblPr = kid(s, 'tblPr');
    styles.byId.set(id, {
      type,
      basedOn: attr(kid(s, 'basedOn'), 'val') ?? undefined,
      p: parsePPr(kid(s, 'pPr')),
      r: parseRPr(kid(s, 'rPr'), theme),
      tblBorders: parseTblBorders(kid(tblPr, 'tblBorders')),
      cellMar: parseCellMar(kid(tblPr, 'tblCellMar')),
    });
    if (attr(s, 'default') === '1' || attr(s, 'default') === 'true') {
      if (type === 'paragraph') styles.defaultPara = id;
      if (type === 'table') styles.defaultTable = id;
    }
  }
  return styles;
}

function styleChain(styles: Styles, id: string | undefined): StyleDef[] {
  const chain: StyleDef[] = [];
  const seen = new Set<string>();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const s = styles.byId.get(cur);
    if (!s) break;
    chain.unshift(s);
    cur = s.basedOn;
  }
  return chain;
}

interface Level {
  start: number;
  fmt: string;
  text: string;
  suff: string;
  p: ParaProps;
  r: RunProps;
}

interface Numbering {
  abstracts: Map<string, Map<number, Level>>;
  nums: Map<string, { abstractId: string; overrides: Map<number, number> }>;
}

function parseNumbering(doc: Document | null, theme: Theme): Numbering {
  const out: Numbering = { abstracts: new Map(), nums: new Map() };
  const root = doc?.documentElement ?? null;
  for (const a of kids(root, 'abstractNum')) {
    const levels = new Map<number, Level>();
    for (const l of kids(a, 'lvl')) {
      levels.set(num(attr(l, 'ilvl')) ?? 0, {
        start: num(attr(kid(l, 'start'), 'val')) ?? 1,
        fmt: attr(kid(l, 'numFmt'), 'val') ?? 'decimal',
        text: attr(kid(l, 'lvlText'), 'val') ?? '',
        suff: attr(kid(l, 'suff'), 'val') ?? 'tab',
        p: parsePPr(kid(l, 'pPr')),
        r: parseRPr(kid(l, 'rPr'), theme),
      });
    }
    out.abstracts.set(attr(a, 'abstractNumId') ?? '', levels);
  }
  for (const n of kids(root, 'num')) {
    const overrides = new Map<number, number>();
    for (const o of kids(n, 'lvlOverride')) {
      const start = num(attr(kid(o, 'startOverride'), 'val'));
      if (start !== undefined) overrides.set(num(attr(o, 'ilvl')) ?? 0, start);
    }
    out.nums.set(attr(n, 'numId') ?? '', { abstractId: attr(kid(n, 'abstractNumId'), 'val') ?? '', overrides });
  }
  return out;
}

function roman(n: number): string {
  const map: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}
function letters(n: number): string {
  // Word repeats the letter past z: aa, bb …
  const ch = String.fromCharCode(97 + ((n - 1) % 26));
  return ch.repeat(Math.floor((n - 1) / 26) + 1);
}
export function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case 'lowerLetter': return letters(n);
    case 'upperLetter': return letters(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    case 'decimalZero': return n < 10 ? `0${n}` : String(n);
    case 'ordinal': return `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
    case 'none': return '';
    default: return String(n);
  }
}

/** Symbol / Wingdings private-use characters → the Unicode glyph they draw. */
const SYMBOL_MAP: Record<number, string> = {
  0xf0b7: '•', 0xf0a7: '▪', 0xf0d8: '➢', 0xf0fc: '✓', 0xf0fb: '✗', 0xf06f: '☐', 0xf0a8: '☐', 0xf0fe: '☑', 0xf0fd: '☒',
  0xf076: '❖', 0xf0e0: '→', 0xf0e8: '➔', 0xf06e: '■', 0xf071: '❑', 0xf0b2: '◊', 0xf02d: '–', 0xf0a1: '○', 0xf09f: '•',
  0xf0a2: '●', 0xf0b0: '°',
};
export function mapSymbol(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xf000 && code <= 0xf0ff) out += SYMBOL_MAP[code] ?? String.fromCodePoint(code - 0xf000);
    else out += ch;
  }
  return out;
}

// ─── Conversion context ─────────────────────────────────────────────────────

interface Rel {
  target: string;
  type: string;
  external: boolean;
}

interface Part {
  path: string; // e.g. word/document.xml
  rels: Map<string, Rel>;
}

interface Ctx {
  zip: JSZip;
  styles: Styles;
  numbering: Numbering;
  theme: Theme;
  base: { p: ParaProps; r: RunProps };
  counters: Map<string, number[]>;
  startedNums: Set<string>;
  fonts: Set<string>;
  defaultTab: number; // px
  warnings: Set<string>;
  images: Map<string, string>; // zip path → data URI
  imageBytes: number;
  tableStyle?: StyleDef[];
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

async function loadRels(zip: JSZip, partPath: string): Promise<Map<string, Rel>> {
  const dir = partPath.slice(0, partPath.lastIndexOf('/') + 1);
  const file = `${dir}_rels/${partPath.slice(dir.length)}.rels`;
  const xml = await zip.file(file)?.async('string');
  const rels = new Map<string, Rel>();
  if (!xml) return rels;
  const doc = parseXml(xml);
  for (const r of kids(doc.documentElement, 'Relationship')) {
    const id = r.getAttribute('Id');
    const target = r.getAttribute('Target') ?? '';
    if (!id) continue;
    const external = r.getAttribute('TargetMode') === 'External';
    rels.set(id, { target: external ? target : resolvePath(dir, target), type: r.getAttribute('Type') ?? '', external });
  }
  return rels;
}

function resolvePath(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dir + target).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function parseXml(xml: string): Document {
  return new DOMParser({ errorHandler: { warning: () => undefined, error: () => undefined, fatalError: () => undefined } }).parseFromString(xml, 'text/xml') as unknown as Document;
}

async function imageUri(ctx: Ctx, part: Part, relId: string | null): Promise<string | null> {
  if (!relId) return null;
  const rel = part.rels.get(relId);
  if (!rel || rel.external) return null;
  const cached = ctx.images.get(rel.target);
  if (cached) return cached;
  const ext = rel.target.split('.').pop()?.toLowerCase() ?? '';
  const mime = IMAGE_TYPES[ext];
  if (!mime) {
    ctx.warnings.add(`An image in ${ext.toUpperCase()} format can't be shown in a browser and was left out. Save it as PNG or JPEG in the document.`);
    return null;
  }
  const b64 = await ctx.zip.file(rel.target)?.async('base64');
  if (!b64) return null;
  ctx.imageBytes += b64.length;
  const uri = `data:${mime};base64,${b64}`;
  ctx.images.set(rel.target, uri);
  return uri;
}

// ─── CSS builders ───────────────────────────────────────────────────────────

function runCss(r: RunProps, base: RunProps): string {
  const css: string[] = [];
  if (r.font && r.font !== base.font) css.push(`font-family:${fontStack(r.font)}`);
  const size = r.vertAlign === 'superscript' || r.vertAlign === 'subscript' ? (r.size ?? base.size ?? 11) * 0.65 : r.size;
  if (size && size !== base.size) css.push(`font-size:${r2(size)}pt`);
  if (r.bold) css.push('font-weight:700');
  else if (r.bold === false && base.bold) css.push('font-weight:400');
  if (r.italic) css.push('font-style:italic');
  const deco: string[] = [];
  if (r.underline && r.underline !== 'none') deco.push('underline');
  if (r.strike || r.dstrike) deco.push('line-through');
  if (deco.length) {
    css.push(`text-decoration:${deco.join(' ')}`);
    if (r.underline === 'double' || r.dstrike) css.push('text-decoration-style:double');
    else if (r.underline && /dot/.test(r.underline)) css.push('text-decoration-style:dotted');
    else if (r.underline && /dash/.test(r.underline)) css.push('text-decoration-style:dashed');
    else if (r.underline === 'wave' || r.underline === 'wavyHeavy') css.push('text-decoration-style:wavy');
  }
  if (r.color && r.color !== base.color) css.push(`color:${r.color}`);
  const bg = r.highlight ?? r.shade;
  if (bg) css.push(`background-color:${bg}`);
  if (r.vertAlign === 'superscript') css.push('vertical-align:super');
  if (r.vertAlign === 'subscript') css.push('vertical-align:sub');
  if (r.caps) css.push('text-transform:uppercase');
  if (r.smallCaps) css.push('font-variant:small-caps');
  if (r.spacing) css.push(`letter-spacing:${r.spacing}px`);
  return css.join(';');
}

function lineHeightCss(p: ParaProps, mark: RunProps): string | null {
  const factor = lineFactor(mark.font);
  // A missing or zero value is single spacing. Google Docs exports put line="1" (at least) on
  // Normal; a paragraph that then switches the rule to "auto" inherits that 1 and would mean
  // 0.004 lines, so tiny multiples are treated as single too.
  if (p.line === undefined || p.line <= 0 || ((p.lineRule ?? 'auto') === 'auto' && p.line < 120)) return `line-height:${r2(factor)}`;
  if (p.lineRule === 'exact') return `line-height:${r2(p.line / 15)}px`;
  if (p.lineRule === 'atLeast') {
    const natural = (mark.size ?? 11) * (4 / 3) * factor;
    return `line-height:${r2(Math.max(p.line / 15, natural))}px`;
  }
  return `line-height:${r2((p.line / 240) * factor)}`;
}

// ─── Blocks ─────────────────────────────────────────────────────────────────

type Block = El;

/** Body-level children, descending into content controls and tracked insertions. */
function blockChildren(el: El): Block[] {
  const out: Block[] = [];
  for (const c of kids(el)) {
    if (c.localName === 'p' || c.localName === 'tbl') out.push(c);
    else if (c.localName === 'sdt') out.push(...blockChildren(kid(c, 'sdtContent') ?? c));
    else if (c.localName === 'customXml' || c.localName === 'ins' || c.localName === 'smartTag') out.push(...blockChildren(c));
    else if (c.localName === 'AlternateContent') out.push(...blockChildren(kid(c, 'Choice') ?? kid(c, 'Fallback') ?? c));
  }
  return out;
}

async function renderBlocks(ctx: Ctx, part: Part, blocks: Block[]): Promise<string> {
  let html = '';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.localName === 'tbl') html += await renderTable(ctx, part, b);
    else html += await renderParagraph(ctx, part, b, blocks[i - 1], blocks[i + 1]);
  }
  return html;
}

const styleIdOf = (p: El | undefined) => (p && p.localName === 'p' ? attr(path(p, 'pPr', 'pStyle'), 'val') ?? undefined : undefined);

function paragraphProps(ctx: Ctx, p: El): { props: ParaProps; mark: RunProps; styleRuns: RunProps; styleId?: string; level?: Level; numKey?: string } {
  const pPr = kid(p, 'pPr');
  const styleId = attr(kid(pPr, 'pStyle'), 'val') ?? ctx.styles.defaultPara;
  const chain = styleChain(ctx.styles, styleId);
  const direct = parsePPr(pPr);
  const tableP = ctx.tableStyle?.map((s) => s.p) ?? [];
  const tableR = ctx.tableStyle?.map((s) => s.r) ?? [];
  let props = mergePara(ctx.styles.defaults.p, ...tableP, ...chain.map((s) => s.p), direct);
  let level: Level | undefined;
  let numKey: string | undefined;
  if (props.numId && props.numId !== '0') {
    const numDef = ctx.numbering.nums.get(props.numId);
    const levels = numDef ? ctx.numbering.abstracts.get(numDef.abstractId) : undefined;
    level = levels?.get(props.ilvl ?? 0);
    if (level) {
      numKey = numDef!.abstractId;
      // Direct indents beat the list's, which beat the paragraph style's.
      props = mergePara(ctx.styles.defaults.p, ...tableP, ...chain.map((s) => s.p), level.p, direct);
    }
  }
  // Runs inherit the paragraph style; the paragraph mark (pPr/rPr) only formats the mark itself,
  // which sets the height of an empty paragraph.
  const styleRuns = merge<RunProps>(ctx.styles.defaults.r, ...tableR, ...chain.map((s) => s.r));
  const mark = merge<RunProps>(styleRuns, parseRPr(kid(pPr, 'rPr'), ctx.theme));
  return { props, mark, styleRuns, styleId, level, numKey };
}

function listLabel(ctx: Ctx, numId: string, numKey: string, ilvl: number, level: Level): string {
  const numDef = ctx.numbering.nums.get(numId)!;
  const levels = ctx.numbering.abstracts.get(numDef.abstractId)!;
  let counters = ctx.counters.get(numKey);
  if (!counters || (!ctx.startedNums.has(numId) && numDef.overrides.size)) {
    counters = [];
    ctx.counters.set(numKey, counters);
  }
  ctx.startedNums.add(numId);
  const startOf = (l: number) => numDef.overrides.get(l) ?? levels.get(l)?.start ?? 1;
  counters[ilvl] = counters[ilvl] === undefined ? startOf(ilvl) : counters[ilvl]! + 1;
  counters.length = ilvl + 1; // deeper levels restart
  if (level.fmt === 'bullet') return mapSymbol(level.text);
  return level.text.replace(/%(\d)/g, (_m, d: string) => {
    const l = Number(d) - 1;
    const n = counters![l] ?? startOf(l);
    return formatNumber(n, levels.get(l)?.fmt ?? 'decimal');
  });
}

interface Inline {
  kind: 'text' | 'tab' | 'html';
  text?: string;
  html?: string;
  css?: string;
}

async function renderParagraph(ctx: Ctx, part: Part, p: El, prev?: El, next?: El): Promise<string> {
  const { props, mark, styleRuns, styleId, level, numKey } = paragraphProps(ctx, p);
  // The paragraph box carries the font of its text (or, when empty, of its mark), so the line
  // height matches Word; runs then only state how they differ from it.
  const hasText = descendants(p, 't').some((t) => (t.textContent ?? '').length > 0) || descendants(p, 'drawing').length > 0;
  const boxFont = hasText ? styleRuns : mark;
  const ref: RunProps = { font: boxFont.font ?? ctx.base.r.font, size: boxFont.size ?? ctx.base.r.size, color: ctx.base.r.color };
  if (mark.hidden && !descendants(p, 't').length) return '';

  const inlines = await collectInlines(ctx, part, p, styleRuns, ref);
  const css: string[] = ['white-space:pre-wrap', 'margin:0'];
  if (ref.font && ref.font !== ctx.base.r.font) css.push(`font-family:${fontStack(ref.font)}`);
  if (ref.size && ref.size !== ctx.base.r.size) css.push(`font-size:${r2(ref.size)}pt`);
  const align = props.align === 'both' || props.align === 'distribute' ? 'justify' : props.align === 'end' ? 'right' : props.align === 'start' ? 'left' : props.align;
  if (align && align !== 'left') css.push(`text-align:${align}`);

  // Word adds "space before" and "space after" (it doesn't collapse them), so padding, not margins.
  const sameStyle = (o?: El) => !!o && o.localName === 'p' && (styleIdOf(o) ?? ctx.styles.defaultPara) === styleId;
  let before = props.beforeAuto ? 14 * (4 / 3) : props.before ?? 0;
  let after = props.afterAuto ? 14 * (4 / 3) : props.after ?? 0;
  if (props.contextual && sameStyle(prev)) before = 0;
  if (props.contextual && sameStyle(next)) after = 0;
  const bd = props.borders ?? {};
  if (before || bd.top) css.push(`padding-top:${r2(before + (bd.top ? bd.top.space * (4 / 3) : 0))}px`);
  if (after || bd.bottom) css.push(`padding-bottom:${r2(after + (bd.bottom ? bd.bottom.space * (4 / 3) : 0))}px`);
  for (const side of ['top', 'bottom', 'left', 'right'] as const) if (bd[side]) css.push(`border-${side}:${borderCss(bd[side])}`);

  const lh = lineHeightCss(props, boxFont);
  if (lh) css.push(lh);
  if (props.left) css.push(`margin-left:${props.left}px`);
  if (props.right) css.push(`margin-right:${props.right}px`);
  const indent = props.hanging ? -props.hanging : props.firstLine ?? 0;
  if (indent) css.push(`text-indent:${indent}px`);
  if (props.shade) css.push(`background-color:${props.shade}`);
  if (props.pageBreakBefore) css.push('break-before:page');
  if (props.keepNext) css.push('break-after:avoid');
  css.push(`tab-size:${ctx.defaultTab}px`);

  let label = '';
  if (level && numKey && props.numId) {
    const text = listLabel(ctx, props.numId, numKey, props.ilvl ?? 0, level);
    const lr = merge<RunProps>(styleRuns, level.r);
    const lcss = runCss(lr, ref);
    const width = props.hanging ?? 0;
    if (level.suff === 'tab' && width > 0) {
      label = `<span style="display:inline-block;min-width:${width}px;text-indent:0${lcss ? `;${lcss}` : ''}">${esc(text)}</span>`;
    } else {
      label = `<span${lcss ? ` style="${lcss}"` : ''}>${esc(text)}${level.suff === 'space' ? ' ' : level.suff === 'tab' ? '\t' : ''}</span>`;
    }
  }

  const body = renderInlines(inlines, props);
  const content = label + (body || (label ? '' : '<br>'));
  // A section break (other than "continuous") starts a new page after this paragraph.
  const sect = path(p, 'pPr', 'sectPr');
  const sectType = attr(kid(sect, 'type'), 'val');
  const pageAfter = sect && sectType !== 'continuous' ? '<div style="break-after:page"></div>' : '';
  return `<p style="${css.join(';')}">${content}</p>${pageAfter}`;
}

/** Joins runs, placing tab stops: custom left stops as fixed-width cells, a right stop as a flex row. */
function renderInlines(items: Inline[], props: ParaProps): string {
  const pieces: string[][] = [[]];
  for (const it of items) {
    if (it.kind === 'tab') pieces.push([]);
    else pieces[pieces.length - 1]!.push(it.kind === 'html' ? it.html! : it.css ? `<span style="${it.css}">${esc(it.text!)}</span>` : esc(it.text!));
  }
  const segs = pieces.map((p) => p.join(''));
  if (segs.length === 1) return segs[0]!;

  const offset = props.left ?? 0;
  const stops = (props.tabs ?? []).filter((t) => t.val !== 'clear' && t.val !== 'bar').map((t) => ({ ...t, rel: t.pos - offset })).filter((t) => t.rel > 0);
  const lastStop = stops[segs.length - 2];
  if (lastStop && (lastStop.val === 'right' || lastStop.val === 'end' || lastStop.val === 'center')) {
    // "Name ............ Date" style lines: everything before the last tab on the left, the rest ends at the stop.
    const left = renderInlines(
      items.slice(0, lastIndexOfTab(items)),
      { ...props, tabs: stops.slice(0, segs.length - 2).map((s) => ({ val: s.val, pos: s.pos, leader: s.leader })) },
    );
    const leader = lastStop.leader && lastStop.leader !== 'none'
      ? `<span style="flex:1 1 auto;margin:0 3px 0.28em;border-bottom:1px ${lastStop.leader === 'hyphen' ? 'dashed' : lastStop.leader === 'underscore' || lastStop.leader === 'heavy' ? 'solid' : 'dotted'} currentColor"></span>`
      : '<span style="flex:1 1 auto"></span>';
    return `<span style="display:flex;align-items:baseline;max-width:${r2(lastStop.rel)}px;text-indent:0"><span>${left}</span>${leader}<span>${segs[segs.length - 1]}</span></span>`;
  }
  let out = '';
  let from = 0;
  segs.forEach((seg, i) => {
    if (i === segs.length - 1) {
      out += seg;
      return;
    }
    const stop = stops[i];
    if (stop && stop.rel > from) {
      out += `<span style="display:inline-block;min-width:${r2(stop.rel - from)}px;text-indent:0">${seg}</span>`;
      from = stop.rel;
    } else {
      out += `${seg}\t`;
    }
  });
  return out;
}

function lastIndexOfTab(items: Inline[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'tab') return i;
  return items.length;
}

/** Walks a paragraph's runs (through links, fields, content controls, insertions) into inline pieces. */
async function collectInlines(ctx: Ctx, part: Part, p: El, styleRuns: RunProps, ref: RunProps): Promise<Inline[]> {
  const out: Inline[] = [];
  const paraStyleRuns = merge<RunProps>(styleRuns);
  delete paraStyleRuns.hidden;
  let fieldDepth = 0;
  let inFieldCode = false;

  const push = (text: string, css: string) => {
    const last = out[out.length - 1];
    // Neighbouring runs with the same look are one span, so {{fields}} Word split up stay together.
    if (last && last.kind === 'text' && last.css === css) last.text += text;
    else out.push({ kind: 'text', text, css });
  };

  const walk = async (el: El, link?: string): Promise<void> => {
    for (const c of kids(el)) {
      switch (c.localName) {
        case 'r':
          await run(c, link);
          break;
        case 'hyperlink': {
          const rel = part.rels.get(rAttr(c, 'id') ?? '');
          const href = rel?.external && /^(https?:|mailto:)/i.test(rel.target) ? rel.target : undefined;
          await walk(c, href ?? link);
          break;
        }
        case 'fldSimple':
        case 'smartTag':
        case 'customXml':
        case 'ins':
        case 'bdo':
        case 'dir':
          await walk(c, link);
          break;
        case 'sdt':
          await walk(kid(c, 'sdtContent') ?? c, link);
          break;
        case 'AlternateContent':
          await walk(kid(c, 'Choice') ?? kid(c, 'Fallback') ?? c, link);
          break;
        default:
          break; // pPr, bookmarks, proofErr, del (deleted text) …
      }
    }
  };

  const run = async (r: El, link?: string) => {
    const rPr = kid(r, 'rPr');
    const charStyle = attr(kid(rPr, 'rStyle'), 'val') ?? undefined;
    const rp = merge<RunProps>(paraStyleRuns, ...styleChain(ctx.styles, charStyle).map((s) => s.r), parseRPr(rPr, ctx.theme));
    if (rp.font) ctx.fonts.add(rp.font);
    if (rp.hidden) return;
    const css = runCss(rp, ref);
    const wrap = (html: string) => (link ? `<a href="${esc(link)}" style="color:inherit;text-decoration:inherit">${html}</a>` : html);
    for (const c of kids(r)) {
      switch (c.localName) {
        case 'fldChar': {
          const t = attr(c, 'fldCharType');
          if (t === 'begin') { fieldDepth++; inFieldCode = true; }
          else if (t === 'separate') inFieldCode = false;
          else if (t === 'end') { fieldDepth = Math.max(0, fieldDepth - 1); inFieldCode = false; }
          break;
        }
        case 'instrText':
          break;
        case 't':
          if (inFieldCode) break;
          if (link) out.push({ kind: 'html', html: wrap(css ? `<span style="${css}">${esc(c.textContent ?? '')}</span>` : esc(c.textContent ?? '')) });
          else push(c.textContent ?? '', css);
          break;
        case 'sym': {
          const code = parseInt(attr(c, 'char') ?? '', 16);
          if (!Number.isNaN(code)) push(mapSymbol(String.fromCodePoint(code < 0x100 ? code + 0xf000 : code)), css);
          break;
        }
        case 'tab':
          if (!inFieldCode) out.push({ kind: 'tab' });
          break;
        case 'ptab':
          out.push({ kind: 'tab' });
          break;
        case 'br':
        case 'cr':
          if (attr(c, 'type') === 'page') out.push({ kind: 'html', html: '<span style="display:block;break-after:page"></span>' });
          else if (!inFieldCode) push('\n', css);
          break;
        case 'noBreakHyphen':
          push('‑', css);
          break;
        case 'softHyphen':
          push('­', css);
          break;
        case 'drawing':
          out.push({ kind: 'html', html: wrap(await renderDrawing(ctx, part, c)) });
          break;
        case 'pict':
        case 'object':
          out.push({ kind: 'html', html: await renderVml(ctx, part, c) });
          break;
        case 'AlternateContent': {
          const choice = kid(c, 'Choice') ?? kid(c, 'Fallback');
          for (const d of kids(choice)) {
            if (d.localName === 'drawing') out.push({ kind: 'html', html: await renderDrawing(ctx, part, d) });
            else if (d.localName === 'pict') out.push({ kind: 'html', html: await renderVml(ctx, part, d) });
          }
          break;
        }
        default:
          break;
      }
    }
  };

  await walk(p);
  return out;
}

// ─── Images and text boxes ──────────────────────────────────────────────────

const emu = (v: string | null) => (num(v) ?? 0) / 9525;

async function renderDrawing(ctx: Ctx, part: Part, drawing: El): Promise<string> {
  const holder = kid(drawing, 'inline') ?? kid(drawing, 'anchor');
  if (!holder) return '';
  const ext = kid(holder, 'extent');
  const w = r2(emu(attr(ext, 'cx')));
  const h = r2(emu(attr(ext, 'cy')));
  const blip = descendants(holder, 'blip')[0];
  const txbx = descendants(holder, 'txbxContent')[0];
  let inner = '';
  if (blip) {
    const uri = await imageUri(ctx, part, rAttr(blip, 'embed'));
    if (!uri) return '';
    const alt = attr(kid(holder, 'docPr'), 'descr') ?? '';
    inner = `<img src="${uri}" alt="${esc(alt)}" style="display:inline-block;width:${w}px;height:${h}px;max-width:none;vertical-align:bottom">`;
  } else if (txbx) {
    const saved = ctx.tableStyle;
    ctx.tableStyle = undefined;
    const content = await renderBlocks(ctx, part, blockChildren(txbx));
    ctx.tableStyle = saved;
    const ln = descendants(holder, 'ln')[0];
    const lineColor = ln && descendants(ln, 'srgbClr')[0] ? hex(attr(descendants(ln, 'srgbClr')[0]!, 'val')) : undefined;
    const noLine = ln && descendants(ln, 'noFill').length > 0;
    const fillEl = descendants(holder, 'spPr')[0];
    const fill = fillEl ? kid(fillEl, 'solidFill') : null;
    const fillColor = fill ? hex(attr(kid(fill, 'srgbClr'), 'val')) : undefined;
    const border = !noLine && (lineColor || ln) ? `border:${r2(emu(attr(ln!, 'w')) || 0.75)}px solid ${lineColor ?? '#000000'};` : '';
    inner = `<div style="display:inline-block;width:${w}px;min-height:${h}px;padding:3.6pt 7.2pt;vertical-align:top;${border}${fillColor ? `background:${fillColor};` : ''}text-indent:0">${content}</div>`;
  } else {
    return '';
  }
  if (holder.localName === 'inline') return inner;

  // Floating objects: wrapped ones float left/right; "in front of / behind text" sit where Word put them.
  const wrapSquare = kid(holder, 'wrapSquare') ?? kid(holder, 'wrapTight') ?? kid(holder, 'wrapThrough');
  const wrapTopBottom = kid(holder, 'wrapTopAndBottom');
  const posH = kid(holder, 'positionH');
  const alignH = kid(posH, 'align')?.textContent ?? '';
  const offH = emu(kid(posH, 'posOffset')?.textContent ?? '0');
  const distL = r2(emu(attr(holder, 'distL')));
  const distR = r2(emu(attr(holder, 'distR')));
  const distT = r2(emu(attr(holder, 'distT')));
  const distB = r2(emu(attr(holder, 'distB')));
  if (wrapTopBottom) {
    const justify = alignH === 'center' ? 'center' : alignH === 'right' ? 'flex-end' : 'flex-start';
    const pad = alignH ? '' : `padding-left:${r2(Math.max(0, offH))}px;`;
    return `<span style="display:flex;justify-content:${justify};${pad}margin:${distT}px 0 ${distB}px;text-indent:0">${inner}</span>`;
  }
  if (wrapSquare) {
    const side = alignH === 'right' || (!alignH && offH > 300) ? 'right' : 'left';
    return `<span style="float:${side};margin:${distT}px ${side === 'left' ? distR : 0}px ${distB}px ${side === 'right' ? distL : 0}px;text-indent:0">${inner}</span>`;
  }
  const posV = kid(holder, 'positionV');
  const offV = emu(kid(posV, 'posOffset')?.textContent ?? '0');
  const fromV = attr(posV, 'relativeFrom') ?? 'paragraph';
  const top = fromV === 'paragraph' || fromV === 'line' ? offV : 0;
  const leftCss = alignH === 'right' ? 'right:0' : alignH === 'center' ? `left:50%;transform:translateX(-50%)` : `left:${r2(offH)}px`;
  const behind = attr(holder, 'behindDoc') === '1';
  return `<span style="position:relative;display:inline;text-indent:0"><span style="position:absolute;${leftCss};top:${r2(top)}px;z-index:${behind ? 0 : 1}">${inner}</span></span>`;
}

/** Older Word files keep images in VML (<w:pict><v:shape><v:imagedata r:id>). */
async function renderVml(ctx: Ctx, part: Part, pict: El): Promise<string> {
  const img = descendants(pict, 'imagedata')[0];
  if (!img) return '';
  const uri = await imageUri(ctx, part, rAttr(img, 'id'));
  if (!uri) return '';
  const shape = descendants(pict, 'shape')[0];
  const style = shape?.getAttribute('style') ?? '';
  const size = (prop: string) => {
    const m = new RegExp(`${prop}:\\s*([\\d.]+)(pt|px|in)?`).exec(style);
    if (!m) return undefined;
    const v = Number(m[1]);
    return m[2] === 'in' ? v * 96 : m[2] === 'px' ? v : v * (4 / 3);
  };
  const w = size('width');
  const h = size('height');
  return `<img src="${uri}" alt="" style="display:inline-block;max-width:none;${w ? `width:${r2(w)}px;` : ''}${h ? `height:${r2(h)}px;` : ''}vertical-align:bottom">`;
}

// ─── Tables ─────────────────────────────────────────────────────────────────

async function renderTable(ctx: Ctx, part: Part, tbl: El): Promise<string> {
  const tblPr = kid(tbl, 'tblPr');
  const styleId = attr(kid(tblPr, 'tblStyle'), 'val') ?? ctx.styles.defaultTable;
  const chain = styleChain(ctx.styles, styleId);
  const borders: Record<string, Border | null | undefined> = Object.assign({}, ...chain.map((s) => s.tblBorders ?? {}), parseTblBorders(kid(tblPr, 'tblBorders')) ?? {});
  const cellMar: Record<string, number | undefined> = Object.assign({ left: 7.2, right: 7.2, top: 0, bottom: 0 }, ...chain.map((s) => s.cellMar ?? {}), parseCellMar(kid(tblPr, 'tblCellMar')) ?? {});

  const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => twip(num(attr(g, 'w'))) ?? 0);
  const gridTotal = grid.reduce((a, b) => a + b, 0);
  const tblW = kid(tblPr, 'tblW');
  const wType = attr(tblW, 'type');
  const wVal = attr(tblW, 'w');
  let width = '';
  if (wType === 'pct' && wVal) width = `width:${wVal.endsWith('%') ? parseFloat(wVal) : (num(wVal) ?? 5000) / 50}%;`;
  else if (wType === 'dxa' && num(wVal)) width = `width:${twip(num(wVal))}px;`;
  else if (gridTotal) width = `width:${r2(gridTotal)}px;`;
  const jc = attr(kid(tblPr, 'jc'), 'val');
  const tblInd = twip(num(attr(kid(tblPr, 'tblInd'), 'w')));
  const margin = jc === 'center' ? 'margin-left:auto;margin-right:auto;' : jc === 'right' || jc === 'end' ? 'margin-left:auto;' : tblInd ? `margin-left:${tblInd}px;` : '';
  const layout = attr(kid(tblPr, 'tblLayout'), 'type') === 'autofit' && !gridTotal ? 'auto' : 'fixed';

  // Grid positions, spans and vertical merges.
  const rows = kids(tbl, 'tr');
  type Cell = { el: El; col: number; span: number; vmerge: string | null; rowspan: number };
  const table: Cell[][] = rows.map((tr) => {
    let col = num(attr(path(tr, 'trPr', 'gridBefore'), 'val')) ?? 0;
    const cells: Cell[] = [];
    for (const tc of kids(tr).flatMap((c) => (c.localName === 'sdt' ? kids(kid(c, 'sdtContent')) : [c])).filter((c) => c.localName === 'tc')) {
      const tcPr = kid(tc, 'tcPr');
      const span = num(attr(kid(tcPr, 'gridSpan'), 'val')) ?? 1;
      const vm = kid(tcPr, 'vMerge');
      cells.push({ el: tc, col, span, vmerge: vm ? attr(vm, 'val') ?? 'continue' : null, rowspan: 1 });
      col += span;
    }
    return cells;
  });
  for (let r = 0; r < table.length; r++) {
    for (const cell of table[r]!) {
      if (cell.vmerge !== 'restart') continue;
      for (let k = r + 1; k < table.length; k++) {
        const below = table[k]!.find((c) => c.col === cell.col);
        if (below?.vmerge === 'continue') cell.rowspan++;
        else break;
      }
    }
  }
  const lastCol = Math.max(grid.length, ...table.map((cells) => cells.reduce((m, c) => Math.max(m, c.col + c.span), 0)));

  const savedStyle = ctx.tableStyle;
  ctx.tableStyle = chain;
  let body = '';
  for (let r = 0; r < table.length; r++) {
    const tr = rows[r]!;
    const trPr = kid(tr, 'trPr');
    const trH = twip(num(attr(kid(trPr, 'trHeight'), 'val')));
    const cantSplit = onOff(kid(trPr, 'cantSplit'));
    body += `<tr style="${trH ? `height:${trH}px;` : ''}${cantSplit ? 'break-inside:avoid;' : ''}">`;
    for (const cell of table[r]!) {
      if (cell.vmerge === 'continue') continue;
      const tcPr = kid(cell.el, 'tcPr');
      const own = parseTblBorders(kid(tcPr, 'tcBorders')) ?? {};
      const lastRow = r + cell.rowspan - 1 === table.length - 1;
      const side = (name: 'top' | 'bottom' | 'left' | 'right') => {
        if (own[name] !== undefined) return own[name];
        if (name === 'top') return r === 0 ? borders.top : borders.insideH;
        if (name === 'bottom') return lastRow ? borders.bottom : borders.insideH;
        if (name === 'left') return cell.col === 0 ? borders.left : borders.insideV;
        return cell.col + cell.span >= lastCol ? borders.right : borders.insideV;
      };
      const mar = Object.assign({}, cellMar, parseCellMar(kid(tcPr, 'tcMar')) ?? {});
      const shd = hex(attr(kid(tcPr, 'shd'), 'fill'));
      const vAlign = attr(kid(tcPr, 'vAlign'), 'val');
      const css = [
        `border-top:${borderCss(side('top'))}`,
        `border-bottom:${borderCss(side('bottom'))}`,
        `border-left:${borderCss(side('left'))}`,
        `border-right:${borderCss(side('right'))}`,
        `padding:${mar.top ?? 0}px ${mar.right ?? 0}px ${mar.bottom ?? 0}px ${mar.left ?? 0}px`,
        `vertical-align:${vAlign === 'center' ? 'middle' : vAlign === 'bottom' ? 'bottom' : 'top'}`,
        shd ? `background-color:${shd}` : '',
      ].filter(Boolean).join(';');
      const content = await renderBlocks(ctx, part, blockChildren(cell.el));
      body += `<td${cell.span > 1 ? ` colspan="${cell.span}"` : ''}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''} style="${css}">${content || '<br>'}</td>`;
    }
    body += '</tr>';
  }
  ctx.tableStyle = savedStyle;

  const cols = grid.length ? `<colgroup>${grid.map((w) => `<col style="width:${r2(w)}px">`).join('')}</colgroup>` : '';
  return `<table style="border-collapse:collapse;table-layout:${layout};${width}${margin}text-indent:0">${cols}<tbody>${body}</tbody></table>`;
}

// ─── Entry point ────────────────────────────────────────────────────────────

export interface DocxHtml {
  html: string;
  warnings: string[];
  page: { width: number; height: number; top: number; right: number; bottom: number; left: number };
}

/** Page geometry travels with the HTML so the signed PDF uses Word's page size and margins. */
export const PAGE_ATTR = 'data-mf-page';

export async function docxToHtml(buffer: Buffer | ArrayBuffer | Uint8Array): Promise<DocxHtml> {
  const zip = await JSZip.loadAsync(buffer);
  const docPath = 'word/document.xml';
  const docXml = await zip.file(docPath)?.async('string');
  if (!docXml) throw new Error('Not a Word document (word/document.xml is missing).');
  const read = async (p: string) => {
    const x = await zip.file(p)?.async('string');
    return x ? parseXml(x) : null;
  };

  const themeDoc = await read('word/theme/theme1.xml');
  const theme: Theme = {};
  if (themeDoc) {
    const scheme = descendants(themeDoc.documentElement, 'fontScheme')[0];
    theme.major = attr(path(kid(scheme ?? null, 'majorFont'), 'latin'), 'typeface') ?? undefined;
    theme.minor = attr(path(kid(scheme ?? null, 'minorFont'), 'latin'), 'typeface') ?? undefined;
  }
  const styles = parseStyles(await read('word/styles.xml'), theme);
  const numbering = parseNumbering(await read('word/numbering.xml'), theme);
  const settings = await read('word/settings.xml');
  const defaultTab = twip(num(attr(kid(settings?.documentElement ?? null, 'defaultTabStop'), 'val'))) ?? 48;

  const doc = parseXml(docXml);
  const body = kid(doc.documentElement, 'body');
  if (!body) throw new Error('The document has no body.');

  const normal = styleChain(styles, styles.defaultPara);
  const baseR = merge<RunProps>(styles.defaults.r, ...normal.map((s) => s.r));
  const baseP = mergePara(styles.defaults.p, ...normal.map((s) => s.p));
  const ctx: Ctx = {
    zip,
    styles,
    numbering,
    theme,
    base: { p: baseP, r: baseR },
    counters: new Map(),
    startedNums: new Set(),
    fonts: new Set([baseR.font ?? 'Calibri']),
    defaultTab,
    warnings: new Set(),
    images: new Map(),
    imageBytes: 0,
  };
  for (const s of styles.byId.values()) if (s.r.font) ctx.fonts.add(s.r.font);

  // Page size and margins from the last section (the document's own setup).
  const sectPr = kid(body, 'sectPr') ?? descendants(body, 'sectPr').pop() ?? null;
  const pgSz = kid(sectPr, 'pgSz');
  const pgMar = kid(sectPr, 'pgMar');
  const px = (el: El | null, name: string, fallback: number) => twip(num(attr(el, name))) ?? fallback;
  const page = {
    width: px(pgSz, 'w', 793.7),
    height: px(pgSz, 'h', 1122.5),
    top: Math.abs(px(pgMar, 'top', 96)),
    right: px(pgMar, 'right', 96),
    bottom: Math.abs(px(pgMar, 'bottom', 96)),
    left: px(pgMar, 'left', 96),
  };
  if (attr(pgSz, 'orient') === 'landscape' && page.width < page.height) [page.width, page.height] = [page.height, page.width];
  const contentWidth = Math.max(200, page.width - page.left - page.right);

  const part: Part = { path: docPath, rels: await loadRels(zip, docPath) };
  const mainHtml = await renderBlocks(ctx, part, blockChildren(body));

  // The default header and footer, once at the top and bottom (letterheads, reference lines).
  const headerFooter = async (kind: 'headerReference' | 'footerReference') => {
    const refs = kids(sectPr, kind);
    const ref = refs.find((r) => attr(r, 'type') === 'default') ?? refs.find((r) => attr(r, 'type') === 'first') ?? refs[0];
    const rel = ref ? part.rels.get(rAttr(ref, 'id') ?? '') : undefined;
    if (!rel || rel.external) return '';
    const x = await read(rel.target);
    if (!x) return '';
    const hPart: Part = { path: rel.target, rels: await loadRels(zip, rel.target) };
    const saved = ctx.counters;
    ctx.counters = new Map();
    const html = await renderBlocks(ctx, hPart, blockChildren(x.documentElement));
    ctx.counters = saved;
    return html.replace(/<p style="[^"]*"><br><\/p>/g, '').trim() ? html : '';
  };
  const header = await headerFooter('headerReference');
  const footer = await headerFooter('footerReference');

  const baseCss = [
    `font-family:${fontStack(baseR.font ?? 'Calibri')}`,
    `font-size:${r2(baseR.size ?? 11)}pt`,
    `color:${baseR.color ?? '#000000'}`,
    'font-weight:400',
    `line-height:${r2(lineFactor(baseR.font))}`,
    `max-width:${r2(contentWidth)}px`,
    'margin:0 auto',
    'text-align:left',
    'overflow-wrap:break-word',
  ].join(';');
  const fonts = fontImports(ctx.fonts);
  const pageData = [page.width, page.height, page.top, page.right, page.bottom, page.left].map((n) => Math.round(n)).join(' ');
  const html =
    (fonts ? `<style>${fonts}</style>` : '') +
    `<div class="mf-docx" ${PAGE_ATTR}="${pageData}" style="${baseCss}">` +
    (header ? `<div class="mf-docx-header" style="margin-bottom:12px">${header}</div>` : '') +
    mainHtml +
    (footer ? `<div class="mf-docx-footer" style="margin-top:16px">${footer}</div>` : '') +
    '</div>';

  if (ctx.imageBytes > 1_500_000) ctx.warnings.add('This document has large images, so each signing copy is heavy. Compress images in Word (File → Compress Pictures) for faster sending.');
  return { html, warnings: [...ctx.warnings], page };
}

export { cleanFontName };
