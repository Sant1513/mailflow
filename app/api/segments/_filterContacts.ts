import { Prisma } from '@prisma/client';

export interface SegmentFilters {
  primaryEmail?: string;
  name?: string;
  hasConversation?: boolean;
  tags?: string[];
}

/**
 * Translates a segment's filters JSON into a Prisma `Contact` where-clause
 * fragment (without the workspaceId constraint, which the caller adds).
 */
export function buildContactWhere(filters: Record<string, unknown>): Prisma.ContactWhereInput {
  const f = filters as SegmentFilters;
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
