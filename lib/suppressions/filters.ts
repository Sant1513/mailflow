import type { Prisma } from '@prisma/client';
import { isBounceCategory, type BounceCategory } from '@/lib/email/dsn';

/**
 * Suppressions page filters (app/api/suppressions/route.ts), kept in the URL so a filtered view
 * can be shared or reloaded. Pure: turns query params into a Prisma where / orderBy.
 */

/** Quick "type" filter: the reason, or a group of bounce categories. */
export const SUPPRESSION_TYPES = {
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced (any)',
  hard: 'Address / domain gone',
  policy: 'Blocked by policy',
  spam: 'Spam block',
  left: 'Left company',
  full: 'Mailbox full',
  complaint: 'Spam complaint',
  manual: 'Added manually',
} as const;
export type SuppressionType = keyof typeof SUPPRESSION_TYPES;

export const SUPPRESSION_SORTS = { newest: 'Newest first', oldest: 'Oldest first', email: 'Email A–Z' } as const;
export type SuppressionSort = keyof typeof SUPPRESSION_SORTS;

export const SUPPRESSION_SOURCES = ['MANUAL', 'BOUNCE', 'UNSUBSCRIBE', 'COMPLAINT'] as const;
export const SUPPRESSION_REASONS = ['UNSUBSCRIBED', 'BOUNCED', 'COMPLAINT'] as const;

/** A teammate's bounce copied into this workspace (lib/email/bounces.ts). */
export const ORG_COPY_MARKERS = ["bounced on a teammate's send", 'known across the organisation'];

export interface SuppressionFilters {
  q: string | null;
  type: SuppressionType | null;
  category: BounceCategory | 'NONE' | null;
  source: (typeof SUPPRESSION_SOURCES)[number] | null;
  reason: (typeof SUPPRESSION_REASONS)[number] | null;
  /** own: from this workspace's own sends / entries; org: copies of a teammate's bounce. */
  scope: 'own' | 'org' | null;
  /** YYYY-MM-DD, India time, inclusive. */
  from: string | null;
  to: string | null;
  /** campaign:<id> or blast:<id>. */
  send: string | null;
  sort: SuppressionSort;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function pick<T extends string>(v: string | null, allowed: readonly T[]): T | null {
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export function parseSuppressionFilters(params: URLSearchParams): SuppressionFilters {
  const category = params.get('category');
  const send = params.get('send');
  return {
    q: params.get('q')?.trim().slice(0, 200) || null,
    type: pick(params.get('type'), Object.keys(SUPPRESSION_TYPES) as SuppressionType[]),
    category: category === 'NONE' ? 'NONE' : isBounceCategory(category) ? category : null,
    source: pick(params.get('source'), SUPPRESSION_SOURCES),
    reason: pick(params.get('reason'), SUPPRESSION_REASONS),
    scope: pick(params.get('scope'), ['own', 'org'] as const),
    from: DATE.test(params.get('from') ?? '') ? params.get('from') : null,
    to: DATE.test(params.get('to') ?? '') ? params.get('to') : null,
    send: send && /^(campaign|blast):[A-Za-z0-9_-]{1,64}$/.test(send) ? send : null,
    sort: pick(params.get('sort'), Object.keys(SUPPRESSION_SORTS) as SuppressionSort[]) ?? 'newest',
  };
}

/** Start / end of an India-time calendar day. */
export function istDayStart(d: string): Date {
  return new Date(`${d}T00:00:00.000+05:30`);
}
export function istDayEnd(d: string): Date {
  return new Date(`${d}T23:59:59.999+05:30`);
}

const orgCopy: Prisma.EmailSuppressionWhereInput = { OR: ORG_COPY_MARKERS.map((m) => ({ detail: { contains: m } })) };

function typeWhere(type: SuppressionType): Prisma.EmailSuppressionWhereInput {
  switch (type) {
    case 'unsubscribed':
      return { reason: 'UNSUBSCRIBED' };
    case 'bounced':
      return { reason: 'BOUNCED' };
    case 'hard':
      return { reason: 'BOUNCED', category: { in: ['USER_UNKNOWN', 'DOMAIN_NOT_FOUND', 'MAILBOX_DISABLED', 'OTHER_HARD'] } };
    case 'policy':
      return { category: 'POLICY_BLOCK' };
    case 'spam':
      return { category: 'SPAM_BLOCK' };
    case 'left':
      return { category: 'LEFT_COMPANY' };
    case 'full':
      return { category: 'MAILBOX_FULL' };
    case 'complaint':
      return { reason: 'COMPLAINT' };
    case 'manual':
      return { source: 'MANUAL' };
  }
}

export function suppressionWhere(workspaceId: string, f: SuppressionFilters): Prisma.EmailSuppressionWhereInput {
  const and: Prisma.EmailSuppressionWhereInput[] = [{ workspaceId }];
  if (f.q) {
    and.push({
      OR: [
        { email: { contains: f.q, mode: 'insensitive' } },
        { detail: { contains: f.q, mode: 'insensitive' } },
        { remark: { contains: f.q, mode: 'insensitive' } },
        { statusCode: { contains: f.q, mode: 'insensitive' } },
      ],
    });
  }
  if (f.type) and.push(typeWhere(f.type));
  if (f.category) and.push({ category: f.category === 'NONE' ? null : f.category });
  if (f.source) and.push({ source: f.source });
  if (f.reason) and.push({ reason: f.reason });
  if (f.scope === 'org') and.push(orgCopy);
  if (f.scope === 'own') and.push({ NOT: orgCopy });
  if (f.from || f.to) and.push({ createdAt: { ...(f.from ? { gte: istDayStart(f.from) } : {}), ...(f.to ? { lte: istDayEnd(f.to) } : {}) } });
  if (f.send) {
    const [kind, id] = f.send.split(':') as [string, string];
    and.push(kind === 'campaign' ? { campaignId: id } : { recruiterBlastId: id });
  }
  return { AND: and };
}

export function suppressionOrderBy(sort: SuppressionSort): Prisma.EmailSuppressionOrderByWithRelationInput[] {
  if (sort === 'oldest') return [{ createdAt: 'asc' }, { id: 'asc' }];
  if (sort === 'email') return [{ email: 'asc' }, { id: 'asc' }];
  return [{ createdAt: 'desc' }, { id: 'desc' }];
}

/** Is this row a copy of a teammate's bounce? */
export function isOrgCopy(detail: string | null | undefined): boolean {
  return !!detail && ORG_COPY_MARKERS.some((m) => detail.includes(m));
}
