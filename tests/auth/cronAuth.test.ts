import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerMatches, cronAuthorised } from '@/lib/cron/auth';

const URL_ = 'https://mailflow.test/api/cron/dispatch';

describe('cron authorisation', () => {
  beforeEach(() => vi.stubEnv('CRON_SECRET', 's3cret-value'));
  afterEach(() => vi.unstubAllEnvs());

  it('accepts the Bearer header', () => {
    expect(cronAuthorised(new Request(URL_, { headers: { Authorization: 'Bearer s3cret-value' } }))).toBe(true);
  });

  it('refuses the secret in the URL (it would end up in logs)', () => {
    expect(cronAuthorised(new Request(`${URL_}?secret=s3cret-value`))).toBe(false);
  });

  it('refuses a wrong, missing or prefix-only secret', () => {
    expect(cronAuthorised(new Request(URL_, { headers: { Authorization: 'Bearer wrong' } }))).toBe(false);
    expect(cronAuthorised(new Request(URL_))).toBe(false);
    expect(cronAuthorised(new Request(URL_, { headers: { Authorization: 'Bearer s3cret' } }))).toBe(false);
    expect(cronAuthorised(new Request(URL_, { headers: { Authorization: 's3cret-value' } }))).toBe(false);
  });

  it('is closed in production when no secret is configured, open in development', () => {
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(cronAuthorised(new Request(URL_))).toBe(false);
    vi.stubEnv('NODE_ENV', 'development');
    expect(cronAuthorised(new Request(URL_))).toBe(true);
  });

  it('bearerMatches handles a missing header and different lengths', () => {
    expect(bearerMatches(null, 'x')).toBe(false);
    expect(bearerMatches('Bearer xx', 'x')).toBe(false);
    expect(bearerMatches('Bearer x', 'x')).toBe(true);
  });
});
