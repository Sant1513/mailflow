import { z } from 'zod';

/** Generated signing documents are always A4 portrait, in PDF points. */
export const SIGNING_PAGE = { width: 595, height: 842 } as const;

export const DEFAULT_SIGNATURE_BOX = { width: 170, height: 50 } as const;

export const MIN_PLACEMENT = 14;

/**
 * Where a signer's signature is drawn: page is 0-based, the box is in PDF
 * points measured from the page's top-left corner.
 */
export const signaturePlacementSchema = z.object({
  signerIndex: z.number().int().min(1).max(3),
  page: z.number().int().min(0).max(199),
  x: z.number().min(0).max(SIGNING_PAGE.width),
  y: z.number().min(0).max(SIGNING_PAGE.height),
  width: z.number().min(MIN_PLACEMENT).max(SIGNING_PAGE.width),
  height: z.number().min(MIN_PLACEMENT).max(SIGNING_PAGE.height),
  /**
   * The block (paragraph/cell) the box sits under, and how far below that
   * block's start it is. Lets the box follow its text when the document
   * reflows; page/x/y above are the fallback.
   */
  anchor: z.object({ id: z.number().int().min(0).max(100_000), dy: z.number().min(-2000).max(2000) }).optional(),
});

export interface AnchorPosition {
  id: number;
  page: number; // 0-based
  x: number;
  y: number; // PDF points from the page's top edge
}

/** Where a box lands in a given render: via its anchor if that block exists, else its stored position. */
export function resolvePlacement(
  p: SignaturePlacement,
  anchors: Map<number, AnchorPosition>,
): { page: number; x: number; y: number } {
  const a = p.anchor ? anchors.get(p.anchor.id) : undefined;
  return a ? { page: a.page, x: p.x, y: Math.max(0, a.y + p.anchor!.dy) } : { page: p.page, x: p.x, y: p.y };
}

/** Anchors a box to the nearest block starting at or above its top edge on the same page. */
export function anchorPlacement(p: SignaturePlacement, anchors: AnchorPosition[]): SignaturePlacement {
  const onPage = anchors.filter((a) => a.page === p.page);
  if (onPage.length === 0) {
    const { anchor: _drop, ...rest } = p;
    return rest;
  }
  const above = onPage.filter((a) => a.y <= p.y + 0.5);
  let pick: AnchorPosition;
  if (above.length) {
    // The closest line of blocks above the box; within it (e.g. a table row),
    // the cell the box sits in: nearest start to its left, innermost on ties.
    const top = Math.max(...above.map((a) => a.y));
    const row = above.filter((a) => top - a.y < 1);
    const left = row.filter((a) => a.x <= p.x + 0.5);
    pick = (left.length ? left : row).reduce((best, a) =>
      left.length
        ? a.x > best.x || (a.x === best.x && a.id > best.id) ? a : best
        : a.x < best.x ? a : best,
    );
  } else {
    pick = onPage.reduce((best, a) => (a.y < best.y ? a : best));
  }
  return { ...p, anchor: { id: pick.id, dy: Math.round((p.y - pick.y) * 2) / 2 } };
}

export const signaturePlacementsSchema = z.array(signaturePlacementSchema).max(30);

export type SignaturePlacement = z.infer<typeof signaturePlacementSchema>;

/** Reads placements from untrusted JSON (DB column or request metadata). */
export function parsePlacements(raw: unknown): SignaturePlacement[] {
  const parsed = signaturePlacementsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function placementsOf(fieldValues: unknown): SignaturePlacement[] {
  if (!fieldValues || typeof fieldValues !== 'object') return [];
  return parsePlacements((fieldValues as Record<string, unknown>).__signaturePlacements);
}

export function placedSignerIndices(placements: SignaturePlacement[]): number[] {
  return [...new Set(placements.map((p) => p.signerIndex))].sort();
}
