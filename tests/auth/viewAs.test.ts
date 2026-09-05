import { describe, it, expect } from 'vitest';
import { signViewAs, verifyViewAs, VIEW_AS_MAX_AGE_SECONDS } from '@/lib/auth/viewAs';

const KEY = 'test-secret-key';
const NOW = 1_800_000_000_000;

describe('view-as cookie (§9)', () => {
  it('round-trips a workspace id', () => {
    const cookie = signViewAs('ws_abc-123', { now: NOW, key: KEY });
    expect(verifyViewAs(cookie, { now: NOW + 1000, key: KEY })).toBe('ws_abc-123');
  });

  it('expires after the max age', () => {
    const cookie = signViewAs('ws1', { now: NOW, key: KEY });
    expect(verifyViewAs(cookie, { now: NOW + VIEW_AS_MAX_AGE_SECONDS * 1000 + 1, key: KEY })).toBeNull();
  });

  it('honours a custom max age', () => {
    const cookie = signViewAs('ws1', { now: NOW, key: KEY, maxAgeSeconds: 60 });
    expect(verifyViewAs(cookie, { now: NOW + 59_000, key: KEY })).toBe('ws1');
    expect(verifyViewAs(cookie, { now: NOW + 61_000, key: KEY })).toBeNull();
  });

  it('rejects a cookie signed with a different secret', () => {
    const cookie = signViewAs('ws1', { now: NOW, key: KEY });
    expect(verifyViewAs(cookie, { now: NOW, key: 'other' })).toBeNull();
  });

  it('rejects tampering with the workspace id or expiry', () => {
    const cookie = signViewAs('ws1', { now: NOW, key: KEY });
    const [, expires, sig] = cookie.split('.') as [string, string, string];
    expect(verifyViewAs(`ws2.${expires}.${sig}`, { now: NOW, key: KEY })).toBeNull();
    expect(verifyViewAs(`ws1.${Number(expires) + 1}.${sig}`, { now: NOW, key: KEY })).toBeNull();
  });

  it('never throws on garbage input', () => {
    for (const bad of [undefined, null, '', 'a', 'a.b', 'a.b.c.d', 'ws1.notanumber.sig', '../x.1.2']) {
      expect(verifyViewAs(bad, { now: NOW, key: KEY })).toBeNull();
    }
  });

  it('refuses to sign an unsafe workspace id', () => {
    expect(() => signViewAs('ws.1', { now: NOW, key: KEY })).toThrow();
    expect(() => signViewAs('', { now: NOW, key: KEY })).toThrow();
  });

  it('fails closed without a secret', () => {
    const saved = { n: process.env.NEXTAUTH_SECRET, a: process.env.AUTH_SECRET };
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      expect(() => signViewAs('ws1', { now: NOW })).toThrow(/secret/i);
      expect(verifyViewAs('ws1.1.sig', { now: 0 })).toBeNull();
    } finally {
      if (saved.n) process.env.NEXTAUTH_SECRET = saved.n;
      if (saved.a) process.env.AUTH_SECRET = saved.a;
    }
  });
});
