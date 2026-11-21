import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = vi.hoisted(() => ({
  db: { emailProviderAccount: { findMany: vi.fn(async (_q: any): Promise<any[]> => []), update: vi.fn(async (_q: any) => ({})) } },
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/gmail/sync', () => ({ gmailSourceFor: vi.fn() }));
vi.mock('@/lib/gmail/search', () => ({ searchMessageIds: vi.fn() }));

const { scanMailbox, runBounceScan, scanStatus, OVERLAP_MS, RETRY_STEP_BACK_MS, FIRST_WINDOW_DAYS } = await import('@/lib/email/bounceScan');
const { ndrSearchQuery } = await import('@/lib/email/ndrBackfill');

const NOW = Date.parse('2026-11-22T10:00:00Z');
const DAY = 86_400_000;
const acct = (over: Record<string, unknown> = {}) => ({ id: 'a1', emailAddress: 'box@neevlabs.ai', workspaceId: 'w', organizationId: 'o', status: 'CONNECTED', refreshTokenEnc: 'x', bounceScanAt: null, ...over }) as any;
const msg = (id: string, at: string) => ({ id, at: new Date(at) });

/** A fake mailbox: ids come back newest first, like Gmail. */
function deps(notices: { id: string; at: Date }[], opts: { fail?: string[]; searchError?: string; decisions?: string[][] } = {}) {
  const processed: string[] = [];
  const queries: string[] = [];
  const d = {
    reader: () => ({
      search: async (q: string) => {
        queries.push(q);
        if (opts.searchError) throw new Error(opts.searchError);
        return [...notices].sort((a, b) => b.at.getTime() - a.at.getTime()).map((n) => ({ id: n.id }));
      },
      get: async (id: string) => ({ id } as any),
    }),
    process: async (_a: any, raw: any) => {
      const n = notices.find((x) => x.id === raw.id)!;
      if (opts.fail?.includes(n.id)) throw new Error('boom');
      processed.push(n.id);
      return { gmailMessageId: n.id, subject: 's', from: null, receivedAt: n.at, actions: (opts.decisions?.[processed.length - 1] ?? ['SUPPRESS']).map((decision) => ({ decision })) } as any;
    },
  };
  return { d, processed, queries };
}
const lastUpdate = () => db.emailProviderAccount.update.mock.calls.at(-1)![0].data;

beforeEach(() => {
  db.emailProviderAccount.findMany.mockReset().mockResolvedValue([]);
  db.emailProviderAccount.update.mockReset().mockResolvedValue({});
});

describe('the Gmail search', () => {
  it('asks for what arrived after a time, and still matches every kind of notice', () => {
    const q = ndrSearchQuery(0, 1_700_000_000.9);
    expect(q.startsWith('after:1700000000 ')).toBe(true);
    expect(q).toMatch(/mailer-daemon/);
    expect(q).toMatch(/undeliverable/);
    expect(q).toMatch(/message blocked/);
    expect(ndrSearchQuery(30)).toMatch(/^newer_than:30d /);
  });
});

describe('scanMailbox', () => {
  it('a mailbox never scanned looks back 3 days; later scans start 2 hours before where the last one stopped', async () => {
    const a = deps([]);
    await scanMailbox(acct(), { deps: a.d, clock: () => NOW, deadline: NOW + 60_000 });
    expect(a.queries[0]).toContain(`after:${Math.floor((NOW - FIRST_WINDOW_DAYS * DAY) / 1000)}`);
    const prev = NOW - 3600_000;
    const b = deps([]);
    await scanMailbox(acct({ bounceScanAt: new Date(prev) }), { deps: b.d, clock: () => NOW, deadline: NOW + 60_000 });
    expect(b.queries[0]).toContain(`after:${Math.floor((prev - OVERLAP_MS) / 1000)}`);
  });

  it('handles notices oldest first, counts them, and moves the position to now when everything was read', async () => {
    const a = deps([msg('c', '2026-11-22T09:00:00Z'), msg('a', '2026-11-22T07:00:00Z'), msg('b', '2026-11-22T08:00:00Z')], { decisions: [['SUPPRESS'], ['NOTE'], ['SUPPRESS', 'NO_MATCH']] });
    const r = await scanMailbox(acct(), { deps: a.d, clock: () => NOW, deadline: NOW + 60_000, concurrency: 1 });
    expect(a.processed).toEqual(['a', 'b', 'c']);
    expect(r).toMatchObject({ ok: true, notices: 3, suppressed: 2, noted: 2, errors: 0, more: false });
    const u = lastUpdate();
    expect(u.bounceScanAt).toEqual(new Date(NOW));
    expect(u.bounceScanError).toBeNull();
    expect(u.bounceScanNotices).toEqual({ increment: 3 });
  });

  it('a backlog bigger than one run reads the OLDEST first and resumes after the newest one handled (nothing is skipped)', async () => {
    const all = Array.from({ length: 10 }, (_, i) => msg(`n${i}`, `2026-11-22T0${i}:00:00Z`));
    const a = deps(all);
    const r = await scanMailbox(acct(), { deps: a.d, clock: () => NOW, deadline: NOW + 60_000, maxPerMailbox: 4, concurrency: 2 });
    expect(a.processed).toEqual(['n0', 'n1', 'n2', 'n3']);
    expect(r.more).toBe(true);
    expect(lastUpdate().bounceScanAt).toEqual(all[3]!.at); // the next run asks from here (minus the overlap), so n4.. come next
  });

  it('running out of time stops cleanly: progress up to the last notice handled is kept, nothing past it', async () => {
    const all = [msg('a', '2026-11-22T01:00:00Z'), msg('b', '2026-11-22T02:00:00Z'), msg('c', '2026-11-22T03:00:00Z'), msg('d', '2026-11-22T04:00:00Z')];
    const a = deps(all);
    let t = NOW;
    let calls = 0;
    // Each notice takes 20 s of the (fake) clock; the deadline is 30 s away, so only the first pair fits.
    const slow = { ...a.d, process: async (acc: any, raw: any) => { calls++; t += 20_000; return a.d.process(acc, raw); } };
    const r = await scanMailbox(acct(), { deps: slow, clock: () => t, deadline: NOW + 30_000, concurrency: 2 });
    expect(r.more).toBe(true);
    expect(calls).toBe(2);
    expect(lastUpdate().bounceScanAt).toEqual(all[1]!.at);
  });

  it('with no time at all and nothing handled, the position does not move', async () => {
    const a = deps([msg('a', '2026-11-22T01:00:00Z')]);
    const r = await scanMailbox(acct({ bounceScanAt: new Date(NOW - 3600_000) }), { deps: a.d, clock: () => NOW, deadline: NOW - 1000 });
    expect(r.notices).toBe(0);
    expect(r.more).toBe(true);
    expect(lastUpdate().bounceScanAt).toEqual(new Date(NOW - 3600_000)); // written back unchanged
  });

  it('a notice that cannot be read does not stop the others, and the mailbox steps back 6 hours so it is tried again', async () => {
    const a = deps([msg('a', '2026-11-22T07:00:00Z'), msg('bad', '2026-11-22T08:00:00Z'), msg('c', '2026-11-22T09:00:00Z')], { fail: ['bad'] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await scanMailbox(acct(), { deps: a.d, clock: () => NOW, deadline: NOW + 60_000, concurrency: 1 });
    err.mockRestore();
    expect(a.processed).toEqual(['a', 'c']);
    expect(r.errors).toBe(1);
    const u = lastUpdate();
    expect(u.bounceScanAt).toEqual(new Date(NOW - RETRY_STEP_BACK_MS));
    expect(u.bounceScanError).toMatch(/1 notice\(s\) could not be read/);
  });

  it('a mailbox that cannot be searched (revoked access, Gmail down) keeps its position and shows the error', async () => {
    const a = deps([], { searchError: 'invalid_grant: Token has been expired or revoked.' });
    const r = await scanMailbox(acct({ bounceScanAt: new Date(NOW - 1000) }), { deps: a.d, clock: () => NOW, deadline: NOW + 60_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid_grant/);
    const u = lastUpdate();
    expect('bounceScanAt' in u).toBe(false);
    expect(u.bounceScanError).toMatch(/Could not search this mailbox: invalid_grant/);
  });
});

describe('runBounceScan', () => {
  it('visits mailboxes in the order of who was scanned longest ago (never scanned first), only connected ones with saved access', async () => {
    const a = deps([]);
    await runBounceScan({ deps: a.d, clock: () => NOW });
    const q = db.emailProviderAccount.findMany.mock.calls[0]![0];
    expect(q.where).toMatchObject({ status: 'CONNECTED', refreshTokenEnc: { not: null } });
    expect(q.orderBy[0]).toEqual({ bounceScanAt: { sort: 'asc', nulls: 'first' } });
  });
  it('can be pointed at one mailbox', async () => {
    await runBounceScan({ deps: deps([]).d, clock: () => NOW, onlyMailbox: 'x@y.com' });
    expect(db.emailProviderAccount.findMany.mock.calls[0]![0].where.emailAddress).toEqual({ equals: 'x@y.com', mode: 'insensitive' });
  });
  it('totals every mailbox, and lists the ones it had no time for (they go first next run)', async () => {
    db.emailProviderAccount.findMany.mockResolvedValue([acct({ id: 'a1', emailAddress: 'one@x.com' }), acct({ id: 'a2', emailAddress: 'two@x.com' }), acct({ id: 'a3', emailAddress: 'three@x.com' })]);
    const all = deps([msg('n', '2026-11-22T09:00:00Z')]);
    const s = await runBounceScan({ deps: all.d, clock: () => NOW, budgetMs: 60_000 });
    expect(s.mailboxes).toHaveLength(3);
    expect(s).toMatchObject({ notices: 3, suppressed: 3, errors: 0, notReached: [] });
    const late = await runBounceScan({ deps: all.d, clock: () => NOW, budgetMs: 1_000 });
    expect(late.mailboxes).toHaveLength(0);
    expect(late.notReached).toEqual(['one@x.com', 'two@x.com', 'three@x.com']);
  });
  it('one failing mailbox does not stop the others', async () => {
    db.emailProviderAccount.findMany.mockResolvedValue([acct({ id: 'a1', emailAddress: 'bad@x.com' }), acct({ id: 'a2', emailAddress: 'good@x.com' })]);
    const good = deps([msg('n', '2026-11-22T09:00:00Z')]);
    const mixed = { ...good.d, reader: (a: any) => (a.emailAddress === 'bad@x.com' ? { search: async () => { throw new Error('nope'); }, get: async () => null } : good.d.reader()) };
    const s = await runBounceScan({ deps: mixed as any, clock: () => NOW, budgetMs: 60_000 });
    expect(s.mailboxes.map((m) => [m.email, m.ok])).toEqual([['bad@x.com', false], ['good@x.com', true]]);
    expect(s.errors).toBe(1);
  });
});

describe('scanStatus', () => {
  it('says who is covered, who failed, and who cannot be read at all', async () => {
    db.emailProviderAccount.findMany.mockResolvedValue([
      { emailAddress: 'fresh@x.com', status: 'CONNECTED', refreshTokenEnc: 'x', bounceScanAt: new Date(NOW - 5 * 60_000), bounceScanError: null, bounceScanNotices: 10 },
      { emailAddress: 'stale@x.com', status: 'CONNECTED', refreshTokenEnc: 'x', bounceScanAt: new Date(NOW - 5 * 3600_000), bounceScanError: '2 notice(s) could not be read', bounceScanNotices: 3 },
      { emailAddress: 'new@x.com', status: 'CONNECTED', refreshTokenEnc: 'x', bounceScanAt: null, bounceScanError: null, bounceScanNotices: 0 },
      { emailAddress: 'gone@x.com', status: 'DISCONNECTED', refreshTokenEnc: null, bounceScanAt: null, bounceScanError: null, bounceScanNotices: 0 },
      { emailAddress: 'noaccess@x.com', status: 'CONNECTED', refreshTokenEnc: null, bounceScanAt: null, bounceScanError: null, bounceScanNotices: 0 },
    ]);
    const s = await scanStatus('o', NOW);
    expect(s).toMatchObject({ connected: 3, fresh: 1, never: 1, notices: 13 });
    expect(s.failing).toEqual([{ email: 'stale@x.com', error: '2 notice(s) could not be read' }]);
    expect(s.unreadable).toEqual([{ email: 'gone@x.com', status: 'DISCONNECTED' }, { email: 'noaccess@x.com', status: 'NO ACCESS SAVED' }]);
    expect(s.oldest).toBe(new Date(NOW - 5 * 3600_000).toISOString());
  });
});
