import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /login: a signed-in person goes straight into the app (no second Google login); a disabled
 * account counts as signed out (getOptionalSession returns null) so it can't loop between /login
 * and the app's redirect back to /login; ?continue=google (from the old address) auto-starts sign-in.
 */
const session = { value: null as any };
vi.mock('@/lib/auth/session', () => ({ getOptionalSession: vi.fn(async () => session.value) }));
vi.mock('@/lib/auth/options', () => ({ allowedDomainsLabel: () => '@masaischool.com' }));
vi.mock('@/lib/marketing/stats', () => ({ getPublicStats: vi.fn(async () => []) }));
vi.mock('@/lib/app-url', () => ({ appBaseUrl: () => 'https://mailflowbymasai.vercel.app' }));
vi.mock('@/components/marketing/LandingPage', () => ({ LandingPage: () => null }));
vi.mock('@/components/marketing/AutoSignIn', () => ({ AutoSignIn: () => null }));
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect }));

const { default: LoginPage } = await import('@/app/login/page');

const find = (node: any, type: string): boolean => {
  if (!node || typeof node !== 'object') return false;
  if (typeof node.type === 'function' && node.type.name === type) return true;
  const kids = node.props?.children;
  return (Array.isArray(kids) ? kids : [kids]).some((k) => find(k, type));
};

beforeEach(() => {
  vi.clearAllMocks();
  session.value = null;
});

describe('/login', () => {
  it('sends a signed-in person into the app', async () => {
    session.value = { status: 'ACTIVE' };
    await expect(LoginPage({ searchParams: {} })).rejects.toThrow('REDIRECT:/');
  });
  it('sends a pending person into the app too (the app routes them to the pending page)', async () => {
    session.value = { status: 'PENDING' };
    await expect(LoginPage({ searchParams: {} })).rejects.toThrow('REDIRECT:/');
  });
  it('shows the page to a signed-out person, or a disabled one (no session) without redirecting', async () => {
    const page: any = await LoginPage({ searchParams: {} });
    expect(redirect).not.toHaveBeenCalled();
    expect(find(page, 'LandingPage')).toBe(true);
    expect(find(page, 'AutoSignIn')).toBe(false);
  });
  it('?continue=google adds the auto sign-in', async () => {
    const page: any = await LoginPage({ searchParams: { continue: 'google' } });
    expect(find(page, 'AutoSignIn')).toBe(true);
  });
  it('a signed-in person is redirected even with ?continue=google (no second login)', async () => {
    session.value = { status: 'ACTIVE' };
    await expect(LoginPage({ searchParams: { continue: 'google' } })).rejects.toThrow('REDIRECT:/');
  });
});
