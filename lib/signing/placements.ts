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
});

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
