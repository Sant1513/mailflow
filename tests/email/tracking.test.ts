import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { injectTracking, isValidClickDestination } from '@/lib/email/tracking';
import { appBaseUrl } from '@/lib/app-url';

const ENV = { ...process.env };
const payload = { campaignId: 'c1', emailJobId: 'j1', email: 'a@b.com' };

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.APP_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_URL;
  process.env.NEXTAUTH_URL = 'https://mailflow.example.app/';
});
afterEach(() => {
  process.env = { ...ENV };
});

function firstHref(html: string): string {
  return /href="([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&');
}

describe('email link tracking', () => {
  it('uses the live site address, never localhost', () => {
    const html = injectTracking('<a href="https://levelupcareer.in/">Visit</a>', payload, 'w1');
    expect(firstHref(html).startsWith('https://mailflow.example.app/api/track/click/')).toBe(true);
    expect(html).not.toContain('localhost');
    expect(html).toContain('src="https://mailflow.example.app/api/track/open/');
  });

  it('falls back to the Vercel production domain when no URL is configured', () => {
    delete process.env.NEXTAUTH_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'mailflow-six-sooty.vercel.app';
    expect(appBaseUrl()).toBe('https://mailflow-six-sooty.vercel.app');
  });

  it('round-trips destinations with query strings and HTML-escaped ampersands', () => {
    const html = injectTracking('<a href="https://x.com/p?a=1&amp;q=a%26b">x</a>', payload, 'w1');
    const url = new URL(firstHref(html));
    const token = url.pathname.split('/').pop()!;
    const destination = url.searchParams.get('u')!;
    expect(destination).toBe('https://x.com/p?a=1&q=a%26b');
    expect(isValidClickDestination(token, destination, url.searchParams.get('s'))).toBe(true);
  });

  it('rejects a tracking link whose destination was swapped', () => {
    const url = new URL(firstHref(injectTracking('<a href="https://good.com/">x</a>', payload, 'w1')));
    const token = url.pathname.split('/').pop()!;
    expect(isValidClickDestination(token, 'https://evil.example/', url.searchParams.get('s'))).toBe(false);
    expect(isValidClickDestination(token, 'https://good.com/', null)).toBe(false);
  });

  it('tracks pasted URLs and links typed without https:// too', () => {
    const html = injectTracking("<p>Apply: https://levelupcareer.in/apply</p><a href='levelupcareer.in'>site</a>", payload, 'w1');
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1]!.replace(/&amp;/g, '&')));
    const tracked = hrefs.filter((u) => u.pathname.startsWith('/api/track/click/'));
    expect(tracked.map((u) => u.searchParams.get('u'))).toEqual(['https://levelupcareer.in/apply', 'https://levelupcareer.in/']);
    for (const u of tracked) {
      expect(isValidClickDestination(u.pathname.split('/').pop()!, u.searchParams.get('u')!, u.searchParams.get('s'))).toBe(true);
    }
  });

  it('leaves the unsubscribe link direct instead of wrapping it', () => {
    const html = injectTracking('<a href="https://mailflow.example.app/api/unsubscribe/tok">Unsubscribe</a>', payload, 'w1');
    expect(firstHref(html)).toBe('https://mailflow.example.app/api/unsubscribe/tok');
  });
});
