import { describe, expect, it } from 'vitest';
import { BLOCKS, buttonBlock, imageBlock, starterLayout, twoColumnBlock } from '@/lib/templates/emailBlocks';
import { checkEmailStandards, contrastRatio } from '@/lib/templates/emailStandards';

const warnings = (html: string, css?: string) => checkEmailStandards(html, css).items.filter((i) => i.level === 'warn').map((i) => i.id);

describe('the starter layout and blocks follow the standards they teach', () => {
  it('a fresh starter email has one thing to fill in (the button address), then nothing to fix', () => {
    const fresh = starterLayout({ title: 'Drive invite', preheader: 'Register by Friday' });
    expect(warnings(fresh)).toEqual(['links']);
    const r = checkEmailStandards(fresh.replace('href="https://"', 'href="https://masai.com/register"'));
    expect(r.items.filter((i) => i.level === 'warn')).toEqual([]);
    expect(r.items.map((i) => i.id)).toEqual(expect.arrayContaining(['doctype', 'lang', 'viewport', 'width', 'layout', 'role', 'preheader']));
  });

  it('every block on its own is table-based, inline-styled and passes the layout checks', () => {
    for (const b of BLOCKS) {
      const html = b.html();
      expect(html, b.id).not.toMatch(/display\s*:\s*(flex|grid)|position\s*:|float\s*:/i);
      expect(warnings(html), b.id).not.toEqual(expect.arrayContaining(['layout', 'role', 'width']));
    }
  });

  it('the button is bulletproof: colour and padding are on the cell, the link has a real address once set', () => {
    const html = buttonBlock('Register now', 'https://masai.com/register');
    expect(html).toMatch(/<td[^>]*bgcolor="#e5173f"[^>]*padding:14px 28px/);
    expect(html).toContain('href="https://masai.com/register"');
    expect(warnings(html)).not.toContain('links');
  });

  it('an image carries alt text and an explicit width, and escapes what is typed into it', () => {
    const html = imageBlock('https://cdn.masai.com/a.png', 'Campus "HSR" <view>', 536);
    expect(html).toContain('alt="Campus &quot;HSR&quot; &lt;view&gt;"');
    expect(html).toContain('width="536"');
    expect(warnings(html)).not.toEqual(expect.arrayContaining(['alt', 'img-width']));
  });

  it('two columns use the stacking technique with a ghost table for Outlook', () => {
    const html = twoColumnBlock('A', 'B');
    expect(html).toContain('<!--[if mso]>');
    expect(html.match(/display:inline-block;width:100%;max-width:268px/g)).toHaveLength(2);
  });
});

describe('what the checker flags', () => {
  it('a bare, image-heavy, wide email', () => {
    const html = '<table width="900"><tr><td><img src="http://x.com/a.png"><a href="#">click here</a></td></tr></table>';
    expect(warnings(html)).toEqual(expect.arrayContaining(['width', 'role', 'alt', 'img-src', 'img-width', 'links', 'link-text', 'preheader', 'text-ratio']));
  });

  it('document-level problems on a full page', () => {
    expect(warnings('<html><head></head><body><p>Hi</p></body></html>')).toEqual(expect.arrayContaining(['doctype', 'lang', 'viewport', 'title']));
  });

  it('layout the big clients drop', () => {
    expect(warnings('<div style="display:flex;gap:8px">x</div>')).toContain('layout');
    expect(warnings('<div style="float:left">x</div>')).toContain('layout');
  });

  it('low contrast is measured, and large text gets the gentler limit', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(warnings('<p style="color:#999999;background:#ffffff;font-size:16px">grey on white</p>')).toContain('contrast');
    expect(warnings('<p style="color:#767676;background:#ffffff;font-size:16px">AA grey</p>')).not.toContain('contrast');
    expect(warnings('<h1 style="color:#949494;background:#ffffff;font-size:30px">big</h1>')).not.toContain('contrast');
  });

  it('fonts without a fallback, tiny body text, and things mail apps remove', () => {
    expect(warnings('<p style="font-family:Georgia">x</p>')).toContain('font-stack');
    expect(warnings('<p style="font-family:Georgia, serif">x</p>')).not.toContain('font-stack');
    expect(warnings('<p style="font-size:10px">a</p><p style="font-size:11px">b</p>')).toContain('font-size');
    expect(warnings('<form><input></form><script>x()</script>')).toContain('unsupported');
  });

  it('CSS in the CSS tab is called out, because some clients drop embedded styles', () => {
    expect(warnings('<p>Hi</p>', 'p{color:red}')).toContain('css');
    expect(warnings('<p style="color:red">Hi</p>', 'p{margin:0}')).not.toContain('css');
  });

  it('merge fields are left alone', () => {
    expect(warnings('<a href="{{ApplyLink}}">Apply for {{Role}}</a>')).not.toContain('links');
  });

  it('an empty template has nothing to say', () => {
    expect(checkEmailStandards('  ').warnCount).toBe(0);
  });
});
