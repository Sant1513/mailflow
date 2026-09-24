import { describe, expect, it } from 'vitest';
import { autoLinkPlainUrls, normalizeEmailLinks, normalizeHref } from '@/lib/email/links';

describe('normalizeHref', () => {
  it('adds https:// to addresses typed without it', () => {
    expect(normalizeHref('levelupcareer.in')).toBe('https://levelupcareer.in/');
    expect(normalizeHref('www.levelupcareer.in/jobs?x=1')).toBe('https://www.levelupcareer.in/jobs?x=1');
    expect(normalizeHref('//cdn.example.com/a')).toBe('https://cdn.example.com/a');
  });

  it('keeps absolute links and decodes HTML entities', () => {
    expect(normalizeHref('https://levelupcareer.in/')).toBe('https://levelupcareer.in/');
    expect(normalizeHref('https://x.com/p?a=1&amp;b=2')).toBe('https://x.com/p?a=1&b=2');
    expect(normalizeHref('https://x.com/a b')).toBe('https://x.com/a%20b');
  });

  it('leaves non-web links alone', () => {
    for (const v of ['mailto:a@b.com', 'tel:+911234', '#top', '{{link}}', '/relative/path', 'javascript:alert(1)', 'just some words']) {
      expect(normalizeHref(v)).toBeNull();
    }
  });
});

describe('outgoing email links', () => {
  it('fixes hyperlinks however they are quoted or typed', () => {
    const html = normalizeEmailLinks(
      `<a href='levelupcareer.in'>a</a> <a href=www.x.com/p>b</a> <a class="btn" href="https://y.com/?q=1&amp;r=2">c</a> <a href="mailto:a@b.com">d</a>`,
    );
    expect(html).toContain('<a href="https://levelupcareer.in/">a</a>');
    expect(html).toContain('<a href="https://www.x.com/p">b</a>');
    expect(html).toContain('<a class="btn" href="https://y.com/?q=1&amp;r=2">c</a>');
    expect(html).toContain('<a href="mailto:a@b.com">d</a>');
  });

  it('turns pasted URLs into links without touching existing links, styles or attributes', () => {
    const html = autoLinkPlainUrls(
      '<style>.x{background:url(https://img.example/a.png)}</style>' +
        '<p>Apply at https://levelupcareer.in/apply. Or visit www.masaischool.com, today!</p>' +
        '<a href="https://keep.me">https://keep.me</a><img src="https://img.example/b.png">',
    );
    expect(html).toContain('<a href="https://levelupcareer.in/apply">https://levelupcareer.in/apply</a>.');
    expect(html).toContain('<a href="https://www.masaischool.com/">www.masaischool.com</a>,');
    expect(html).toContain('url(https://img.example/a.png)');
    expect(html).toContain('<a href="https://keep.me">https://keep.me</a>');
    expect(html).toContain('<img src="https://img.example/b.png">');
  });

  it('is safe to run twice', () => {
    const once = normalizeEmailLinks('<p>See https://a.com and <a href="b.com">b</a></p>');
    expect(normalizeEmailLinks(once)).toBe(once);
  });
});
