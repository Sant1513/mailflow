import { describe, expect, it } from 'vitest';
import { buildContactWhere, segmentFiltersSchema } from '@/app/api/segments/_filterContacts';

describe('segment filters', () => {
  it('builds the contact filter from valid filters', () => {
    expect(buildContactWhere({ name: ' Asha ', hasConversation: true })).toEqual({
      name: { contains: 'Asha', mode: 'insensitive' },
      conversations: { some: {} },
    });
    expect(buildContactWhere({})).toEqual({});
    expect(buildContactWhere(null)).toEqual({});
  });

  it('a malformed stored segment matches nobody (never everybody) instead of a 500', () => {
    expect(buildContactWhere({ name: 42 })).toEqual({ id: { in: [] } });
    expect(buildContactWhere('garbage')).toEqual({ id: { in: [] } });
  });

  it('refuses malformed filters on save and drops unknown keys', () => {
    expect(segmentFiltersSchema.safeParse({ name: 42 }).success).toBe(false);
    expect(segmentFiltersSchema.parse({ name: 'a', evil: { $where: 1 } })).toEqual({ name: 'a' });
  });
});
