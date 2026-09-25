/**
 * MailFlow ships two products behind one sign-in: Mail (campaigns, inbox,
 * contacts…) and Sign (e-signature). This module is the single source of
 * truth for which routes belong to which product. Shared pages (settings,
 * approvals, admin) belong to neither and keep whichever product you came from.
 */

export type Product = 'mail' | 'sign';

export const PRODUCTS: Record<Product, { name: string; home: string; tagline: string }> = {
  mail: {
    name: 'Mail',
    home: '/dashboard',
    tagline: 'Campaigns, inbox, contacts and automations',
  },
  sign: {
    name: 'Sign',
    home: '/documents',
    tagline: 'Send documents for e-signature, one-off or in bulk',
  },
};

export interface NavItem {
  href: string;
  label: string;
}

export const MAIL_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/data', label: 'Data' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/templates', label: 'Templates' },
  { href: '/documents/library', label: 'PDF Library' },
  { href: '/automations', label: 'Automations' },
  { href: '/batches', label: 'Batches' },
  { href: '/suppressions', label: 'Suppressions' },
  { href: '/performance', label: 'Performance' },
  { href: '/reports', label: 'Reports' },
  { href: '/history', label: 'History' },
];

export const SIGN_NAV: NavItem[] = [
  { href: '/documents', label: 'Documents' },
  { href: '/documents/new', label: 'New Request' },
  { href: '/documents/bulk', label: 'Bulk Send' },
  { href: '/documents/templates', label: 'Templates' },
  { href: '/documents/analytics', label: 'Analytics' },
];

export const PRODUCT_NAV: Record<Product, NavItem[]> = { mail: MAIL_NAV, sign: SIGN_NAV };

const MAIL_PREFIXES = [
  '/dashboard', '/inbox', '/data', '/contacts', '/campaigns', '/templates',
  '/automations', '/batches', '/suppressions', '/performance', '/reports', '/history',
];

const SIGN_DOCUMENT_SECTIONS = new Set(['new', 'bulk', 'templates', 'analytics']);

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The product a route belongs to, or null for shared pages. */
export function productForPath(pathname: string | null | undefined): Product | null {
  if (!pathname) return null;
  const path = pathname.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
  if (path === '/documents') return 'sign';
  if (path.startsWith('/documents/')) {
    // /documents/library and /documents/<pdf id> are the campaign PDF tools (Mail);
    // the named sections are e-signature (Sign).
    const section = path.split('/')[2]!;
    return SIGN_DOCUMENT_SECTIONS.has(section) ? 'sign' : 'mail';
  }
  return MAIL_PREFIXES.some((p) => underPrefix(path, p)) ? 'mail' : null;
}

export function isProduct(value: unknown): value is Product {
  return value === 'mail' || value === 'sign';
}

/** The nav item for the current page: the longest href that contains it. */
export function activeNavHref(pathname: string | null | undefined, items: NavItem[]): string | null {
  if (!pathname) return null;
  let best: string | null = null;
  for (const item of items) {
    if (underPrefix(pathname, item.href) && (!best || item.href.length > best.length)) best = item.href;
  }
  return best;
}

/** Safe "return to where I was" target: a same-site path inside that product. */
export function safeProductPath(product: Product, candidate: string | null | undefined): string {
  if (candidate && candidate.startsWith('/') && !candidate.startsWith('//') && productForPath(candidate) === product) {
    return candidate;
  }
  return PRODUCTS[product].home;
}

// Cookie names (read on the server for redirects, written by the client).
export const DEFAULT_PRODUCT_COOKIE = 'mf_default_product';
export const CURRENT_PRODUCT_COOKIE = 'mf_product';
