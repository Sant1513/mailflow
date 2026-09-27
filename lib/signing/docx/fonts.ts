/**
 * Fonts for imported Word / Google Docs templates. Word's own fonts are not
 * installed on the PDF server (and often not on signers' phones), so each is
 * paired with a metric-compatible web font: same character widths, so lines
 * wrap and pages break where they did in Word. Fonts Google Docs offers are
 * loaded from Google Fonts by their own name.
 */

interface Substitute {
  /** Google Fonts family with the same metrics (or the closest look). */
  web?: string;
  generic: 'serif' | 'sans-serif' | 'monospace' | 'cursive';
  /** Line height of "single" spacing, as a multiple of the font size. */
  lineFactor: number;
}

const SUBSTITUTES: Record<string, Substitute> = {
  calibri: { web: 'Carlito', generic: 'sans-serif', lineFactor: 1.22 },
  'calibri light': { web: 'Carlito', generic: 'sans-serif', lineFactor: 1.22 },
  cambria: { web: 'Caladea', generic: 'serif', lineFactor: 1.17 },
  'cambria math': { web: 'Caladea', generic: 'serif', lineFactor: 1.17 },
  arial: { web: 'Arimo', generic: 'sans-serif', lineFactor: 1.15 },
  helvetica: { web: 'Arimo', generic: 'sans-serif', lineFactor: 1.15 },
  'arial nova': { web: 'Arimo', generic: 'sans-serif', lineFactor: 1.15 },
  'liberation sans': { web: 'Arimo', generic: 'sans-serif', lineFactor: 1.15 },
  'times new roman': { web: 'Tinos', generic: 'serif', lineFactor: 1.15 },
  times: { web: 'Tinos', generic: 'serif', lineFactor: 1.15 },
  'liberation serif': { web: 'Tinos', generic: 'serif', lineFactor: 1.15 },
  'courier new': { web: 'Cousine', generic: 'monospace', lineFactor: 1.13 },
  courier: { web: 'Cousine', generic: 'monospace', lineFactor: 1.13 },
  consolas: { web: 'Cousine', generic: 'monospace', lineFactor: 1.17 },
  georgia: { web: 'Gelasio', generic: 'serif', lineFactor: 1.14 },
  'segoe ui': { web: 'Open Sans', generic: 'sans-serif', lineFactor: 1.33 },
  verdana: { web: 'PT Sans', generic: 'sans-serif', lineFactor: 1.22 },
  tahoma: { web: 'PT Sans', generic: 'sans-serif', lineFactor: 1.21 },
  'trebuchet ms': { web: 'Fira Sans', generic: 'sans-serif', lineFactor: 1.16 },
  garamond: { web: 'EB Garamond', generic: 'serif', lineFactor: 1.12 },
  'book antiqua': { web: 'EB Garamond', generic: 'serif', lineFactor: 1.17 },
  'palatino linotype': { web: 'EB Garamond', generic: 'serif', lineFactor: 1.14 },
  'century gothic': { web: 'Questrial', generic: 'sans-serif', lineFactor: 1.22 },
  aptos: { web: 'Inter', generic: 'sans-serif', lineFactor: 1.22 },
  'aptos display': { web: 'Inter', generic: 'sans-serif', lineFactor: 1.22 },
  'comic sans ms': { web: 'Comic Neue', generic: 'cursive', lineFactor: 1.39 },
};

/** Families on Google Fonts with regular, bold and both italics (safe to request all four). */
const FULL_FAMILIES = new Set([
  'Carlito', 'Caladea', 'Arimo', 'Tinos', 'Cousine', 'Gelasio', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins',
  'Merriweather', 'Playfair Display', 'Raleway', 'Source Sans 3', 'Nunito', 'Noto Sans', 'Noto Serif', 'PT Sans', 'PT Serif',
  'EB Garamond', 'Lora', 'Ubuntu', 'Work Sans', 'Fira Sans', 'IBM Plex Sans', 'IBM Plex Serif', 'Roboto Mono',
  'Mulish', 'Rubik', 'Karla', 'Barlow', 'Josefin Sans', 'Titillium Web', 'Cabin', 'Arvo', 'Bitter', 'Crimson Text', 'Comic Neue',
]);

/** Families on Google Fonts requested as regular only (the browser synthesises bold / italic). */
const PLAIN_FAMILIES = new Set([
  'Inter', 'Oswald', 'Questrial', 'Libre Baskerville', 'Cormorant Garamond', 'Manrope', 'DM Sans', 'Space Grotesk', 'Archivo',
  'Heebo', 'Quicksand', 'Comfortaa', 'Dancing Script', 'Pacifico', 'Caveat', 'Great Vibes', 'Amatic SC', 'Lobster', 'Outfit',
  'Roboto Slab', 'Spectral', 'Alegreya', 'Old Standard TT', 'Cardo', 'Varela Round', 'Exo 2', 'Abril Fatface', 'Anton',
]);

const ALL_WEB = new Map([...FULL_FAMILIES, ...PLAIN_FAMILIES].map((f) => [f.toLowerCase(), f]));

/** Font names come from the document: keep them to characters that are safe inside CSS. */
export function cleanFontName(name: string): string {
  return name.replace(/[^\w \-.&]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function guessGeneric(name: string): Substitute['generic'] {
  const n = name.toLowerCase();
  if (/mono|courier|consol|code/.test(n)) return 'monospace';
  if (/script|hand|brush|vibes|pacifico|caveat/.test(n)) return 'cursive';
  if (/serif|times|roman|garamond|georgia|book|baskerville|minion|palatino|cambria|merriweather|lora|slab/.test(n) && !/sans/.test(n)) return 'serif';
  return 'sans-serif';
}

/** CSS font-family list for a Word font name: the font itself, its web twin, a generic. */
export function fontStack(name: string | undefined): string {
  const clean = cleanFontName(name ?? '');
  if (!clean) return 'sans-serif';
  const sub = SUBSTITUTES[clean.toLowerCase()];
  const parts = [`'${clean}'`];
  if (sub?.web && sub.web.toLowerCase() !== clean.toLowerCase()) parts.push(`'${sub.web}'`);
  parts.push(sub?.generic ?? guessGeneric(clean));
  return parts.join(',');
}

export function lineFactor(name: string | undefined): number {
  return SUBSTITUTES[cleanFontName(name ?? '').toLowerCase()]?.lineFactor ?? 1.17;
}

/** One @import per family, so a family Google doesn't have can't break the others. */
export function fontImports(names: Iterable<string>): string {
  const families = new Set<string>();
  for (const raw of names) {
    const clean = cleanFontName(raw);
    if (!clean) continue;
    const sub = SUBSTITUTES[clean.toLowerCase()];
    if (sub?.web) families.add(sub.web);
    const direct = ALL_WEB.get(clean.toLowerCase());
    if (direct) families.add(direct);
  }
  return [...families]
    .sort()
    .map((f) => {
      const fam = encodeURIComponent(f).replace(/%20/g, '+');
      const spec = FULL_FAMILIES.has(f) ? ':ital,wght@0,400;0,700;1,400;1,700' : '';
      return `@import url('https://fonts.googleapis.com/css2?family=${fam}${spec}&display=swap');`;
    })
    .join('');
}
