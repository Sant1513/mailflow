import { EMAIL_FONTS } from '@/lib/editor/convert';

const FALLBACK = new Map(EMAIL_FONTS.map((f) => [f.name.toLowerCase(), f.fallback]));

/** After execCommand('fontName'): give every font in the editor a generic fallback (a mail app without the font shows a similar one). */
export function addFontFallbacks(root: HTMLElement, chosen: string): void {
  const fb = FALLBACK.get(chosen.toLowerCase()) ?? 'sans-serif';
  root.querySelectorAll<HTMLElement>('span[style*="font-family"], font[face]').forEach((n) => {
    const fam = n.style.fontFamily;
    if (fam && !/(sans-serif|serif|monospace|cursive)\s*$/i.test(fam)) n.style.fontFamily = `${fam}, ${fb}`;
  });
}

/** After execCommand('fontSize', '7'): the largest legacy size is only a marker, replaced here by the real pixel size. */
export function applyPixelSize(root: HTMLElement, px: number | string): void {
  root.querySelectorAll<HTMLElement>('font[size="7"], span[style*="xxx-large"]').forEach((n) => {
    n.removeAttribute('size');
    n.style.fontSize = `${px}px`;
  });
}
