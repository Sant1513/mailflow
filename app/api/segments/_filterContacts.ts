import { Prisma } from '@prisma/client';
import { z } from 'zod';

/** The only shape a segment's filters may have; unknown keys are dropped. */
export const segmentFiltersSchema = z
  .object({
    primaryEmail: z.string().max(320).optional(),
    name: z.string().max(200).optional(),
    hasConversation: z.boolean().optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
  })
  .strip();

export type SegmentFilters = z.infer<typeof segmentFiltersSchema>;

/**
 * Translates a segment's filters JSON into a Prisma `Contact` where-clause
 * fragment (without the workspaceId constraint, which the caller adds).
 * Stored JSON is checked again here: an older malformed segment (e.g. a number
 * where text belongs) matches NOBODY rather than throwing a 500 — and never
 * everybody, which would turn a segment send into an email to every contact.
 */
export function buildContactWhere(filters: unknown): Prisma.ContactWhereInput {
  const parsed = segmentFiltersSchema.safeParse(filters ?? {});
  if (!parsed.success) return { id: { in: [] } };
  const f: SegmentFilters = parsed.data;
  const where: Prisma.ContactWhereInput = {};

  if (f.primaryEmail?.trim()) {
    where.primaryEmail = { contains: f.primaryEmail.trim(), mode: 'insensitive' };
  }

  if (f.name?.trim()) {
    where.name = { contains: f.name.trim(), mode: 'insensitive' };
  }

  if (f.hasConversation === true) {
    where.conversations = { some: {} };
  } else if (f.hasConversation === false) {
    where.conversations = { none: {} };
  }

  return where;
}
