import { describe, expect, it } from 'vitest';
import {
  MAIL_NAV,
  SIGN_NAV,
  activeNavHref,
  isProduct,
  productForPath,
  safeProductPath,
} from '@/lib/products';

describe('which product a page belongs to', () => {
  it('puts e-signature pages in Sign', () => {
    for (const p of ['/documents', '/documents/', '/documents/new', '/documents/bulk', '/documents/bulk/abc', '/documents/bulk/new', '/documents/templates/xyz', '/documents/analytics', '/documents?status=SENT']) {
      expect(productForPath(p)).toBe('sign');
    }
  });

  it('keeps the campaign PDF tools (same /documents prefix) in Mail', () => {
    expect(productForPath('/documents/library')).toBe('mail');
    expect(productForPath('/documents/clx9pdfid123')).toBe('mail');
  });

  it('puts mail pages in Mail without catching look-alike prefixes', () => {
    for (const p of ['/dashboard', '/inbox/123', '/campaigns/abc', '/contacts/segments', '/templates/1', '/history']) {
      expect(productForPath(p)).toBe('mail');
    }
    expect(productForPath('/dashboards-x')).toBeNull();
  });

  it('treats settings, approvals and admin as shared', () => {
    for (const p of ['/settings', '/settings/sla', '/approvals', '/admin/users', '/choose', '/', null]) {
      expect(productForPath(p)).toBeNull();
    }
  });

  it('every nav item belongs to its own product', () => {
    expect(MAIL_NAV.every((i) => productForPath(i.href) === 'mail')).toBe(true);
    expect(SIGN_NAV.every((i) => productForPath(i.href) === 'sign')).toBe(true);
  });
});

describe('nav highlighting', () => {
  it('highlights only the most specific item', () => {
    expect(activeNavHref('/documents/templates/abc', SIGN_NAV)).toBe('/documents/templates');
    expect(activeNavHref('/documents', SIGN_NAV)).toBe('/documents');
    expect(activeNavHref('/templates/9', MAIL_NAV)).toBe('/templates');
    expect(activeNavHref('/documents/library', MAIL_NAV)).toBe('/documents/library');
  });
});

describe('returning to the last page in a product', () => {
  it('only accepts same-site paths inside that product', () => {
    expect(safeProductPath('sign', '/documents/bulk/abc?x=1')).toBe('/documents/bulk/abc?x=1');
    expect(safeProductPath('sign', '/campaigns')).toBe('/documents');
    expect(safeProductPath('mail', '//evil.example/dashboard')).toBe('/dashboard');
    expect(safeProductPath('mail', 'https://evil.example')).toBe('/dashboard');
    expect(safeProductPath('mail', null)).toBe('/dashboard');
  });

  it('validates stored product names', () => {
    expect(isProduct('mail')).toBe(true);
    expect(isProduct('sign')).toBe(true);
    expect(isProduct('admin')).toBe(false);
    expect(isProduct(undefined)).toBe(false);
  });
});
