import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';

/** §23/§97: the preview must never execute attacker-controlled JavaScript. */
describe('sanitizeEmailHtml — XSS vectors', () => {
  const vectors: [string, string][] = [
    ['inline script tag', '<p>ok</p><script>alert(1)</script>'],
    ['event handler', '<div onclick="alert(1)">click</div>'],
    ['onerror on image', '<img src="x" onerror="alert(1)">'],
    ['javascript: href', '<a href="javascript:alert(1)">go</a>'],
    ['javascript: with mixed case', '<a href="JaVaScRiPt:alert(1)">go</a>'],
    ['iframe injection', '<iframe src="https://evil.example"></iframe>'],
    ['object embed', '<object data="evil.swf"></object>'],
    ['svg onload', '<svg onload="alert(1)"></svg>'],
    ['form exfiltration', '<form action="https://evil.example"><input name="p"></form>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ['base tag hijack', '<base href="https://evil.example/">'],
    ['data: URI in anchor', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
  ];

  for (const [name, input] of vectors) {
    it(`neutralizes ${name}`, () => {
      const out = sanitizeEmailHtml(input);
      expect(out.toLowerCase()).not.toContain('<script');
      expect(out.toLowerCase()).not.toContain('onerror');
      expect(out.toLowerCase()).not.toContain('onclick');
      expect(out.toLowerCase()).not.toContain('onload');
      expect(out.toLowerCase()).not.toContain('javascript:');
      expect(out.toLowerCase()).not.toContain('<iframe');
      expect(out.toLowerCase()).not.toContain('<object');
      expect(out.toLowerCase()).not.toContain('<form');
      expect(out.toLowerCase()).not.toContain('<base');
    });
  }

  it('drops script CONTENT, not just the tag', () => {
    const out = sanitizeEmailHtml('<script>stealCookies()</script>');
    expect(out).not.toContain('stealCookies');
  });
});

describe('sanitizeEmailHtml — legitimate email markup survives', () => {
  it('keeps table layout, inline styles and attributes emails depend on', () => {
    const html =
      '<table width="600" cellpadding="0" bgcolor="#ffffff"><tr><td style="padding:32px;color:#333" align="center">Hi</td></tr></table>';
    const out = sanitizeEmailHtml(html);
    expect(out).toContain('<table');
    expect(out).toContain('width="600"');
    expect(out).toContain('bgcolor="#ffffff"');
    expect(out).toContain('style="padding:32px;color:#333"');
    expect(out).toContain('align="center"');
  });

  it('keeps <style> blocks, which emails need for layout', () => {
    const out = sanitizeEmailHtml('<style>.btn{color:red}</style><p class="btn">x</p>');
    expect(out).toContain('.btn{color:red}');
    expect(out).toContain('class="btn"');
  });

  it('keeps https links and images, adding safe target/rel', () => {
    const out = sanitizeEmailHtml('<a href="https://masaischool.com">site</a><img src="https://x.test/a.png">');
    expect(out).toContain('href="https://masaischool.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('src="https://x.test/a.png"');
  });

  it('keeps mailto: and tel: links', () => {
    const out = sanitizeEmailHtml('<a href="mailto:a@masaischool.com">mail</a><a href="tel:+911234">call</a>');
    expect(out).toContain('mailto:a@masaischool.com');
    expect(out).toContain('tel:+911234');
  });

  it('allows data: images (inlined logos) but not data: documents', () => {
    const out = sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(out).toContain('data:image/png');
  });
});
