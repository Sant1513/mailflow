import { escapeHtml } from '@/lib/signing/fields';

export type SignatureAlign = 'left' | 'center' | 'right';

export interface SignatureSlot {
  signerIndex: number; // 1-based
  role?: string;
  name?: string;
  image?: string; // data URL or raw base64 PNG
  signedAt?: Date | string;
}

export interface ParsedSignatureToken {
  signerIndex: number;
  align: SignatureAlign;
}

// [[signature]]  [[signature:2]]  [[signature:2:right]]  [[signature:center]]
const TOKEN_SRC = String.raw`\[\[\s*signature(?:\s*:\s*([1-3]))?(?:\s*:\s*(left|center|right))?\s*\]\]`;

export function signatureTokenRegex(): RegExp {
  return new RegExp(TOKEN_SRC, 'gi');
}

export function signatureToken(signerIndex: number, align: SignatureAlign): string {
  if (signerIndex === 1 && align === 'left') return '[[signature]]';
  return `[[signature:${signerIndex}${align === 'left' ? '' : `:${align}`}]]`;
}

export function parseSignatureToken(signer?: string, align?: string): ParsedSignatureToken {
  return {
    signerIndex: signer ? Number(signer) : 1,
    align: (align?.toLowerCase() as SignatureAlign | undefined) ?? 'left',
  };
}

export function hasSignatureTokens(content: string): boolean {
  return signatureTokenRegex().test(content);
}

function imageSrc(image: string): string {
  return image.startsWith('data:') ? image : `data:image/png;base64,${image}`;
}

function formatSignedAt(value: Date | string | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? '' : d.toUTCString();
}

/**
 * Replaces signature tokens with inline signature blocks. Slots without an
 * image render as an empty signing line labelled with `placeholderLabel`.
 */
export function renderSignatureTokensHtml(
  html: string,
  slots: SignatureSlot[],
  options: { placeholderLabel?: (signerIndex: number, slot?: SignatureSlot) => string; highlightSigner?: number } = {},
): string {
  const bySigner = new Map(slots.map((s) => [s.signerIndex, s]));
  return html.replace(signatureTokenRegex(), (_m, signer?: string, align?: string) => {
    const tok = parseSignatureToken(signer, align);
    const slot = bySigner.get(tok.signerIndex);
    const highlight = options.highlightSigner === tok.signerIndex;
    const label = slot?.role || `Signer ${tok.signerIndex}`;
    const inner = slot?.image
      ? `<img src="${imageSrc(slot.image)}" alt="Signature of ${escapeHtml(slot.name ?? label)}" style="display:block;max-height:60px;max-width:220px">`
      : `<span style="display:block;height:48px;line-height:48px;color:${highlight ? '#b45309' : '#9ca3af'};font-size:12px;font-style:italic">${escapeHtml(
          options.placeholderLabel?.(tok.signerIndex, slot) ?? `${label} signs here`,
        )}</span>`;
    const caption = slot?.image
      ? `${escapeHtml(label)}${slot.name ? ` &middot; ${escapeHtml(slot.name)}` : ''}${slot.signedAt ? ` &middot; ${escapeHtml(formatSignedAt(slot.signedAt))}` : ''}`
      : `${escapeHtml(label)}${slot?.name ? ` &middot; ${escapeHtml(slot.name)}` : ''}`;
    const boxStyle = [
      'display:inline-block',
      'min-width:220px',
      'text-align:left',
      'padding:4px 8px',
      `border-bottom:1.5px solid ${highlight ? '#f59e0b' : '#9ca3af'}`,
      highlight ? 'background:#fffbeb' : '',
    ].filter(Boolean).join(';');
    return `<span data-signature-slot="${tok.signerIndex}" style="display:block;margin:14px 0;text-align:${tok.align}"><span style="${boxStyle}">${inner}</span><span style="display:block;font-size:11px;color:#6b7280;margin-top:2px">${caption}</span></span>`;
  });
}
