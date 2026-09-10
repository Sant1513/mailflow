import { describe, it, expect } from 'vitest';
import { formatHtml, looksMinified, tokenize } from '@/lib/templates/format';

/** Whitespace touching a tag boundary is what browsers collapse; that is all formatting may add. */
const squash = (s: string) => s.replace(/>\s+/g, '>').replace(/\s+</g, '<').replace(/\s+/g, ' ').trim();

describe('tokenize', () => {
  it('keeps a ">" inside a quoted attribute in one tag', () => {
    const toks = tokenize('<a title="x > y" href=\'a>b\'>link</a>');
    expect(toks.map((t) => t.kind)).toEqual(['tag', 'text', 'tag']);
    expect(toks[0]).toMatchObject({ name: 'a', closing: false });
  });

  it('treats comments as one token', () => {
    expect(tokenize('<!-- a > b --><p>x</p>')[0]).toEqual({ kind: 'comment', value: '<!-- a > b -->' });
  });
});

describe('formatHtml', () => {
  it('puts block elements on indented lines and keeps inline content together', () => {
    const input = '<div><p>Hi <strong>{{Name}}</strong>, welcome.</p><ul><li>One</li><li>Two <a href="#">link</a></li></ul></div>';
    expect(formatHtml(input)).toBe(
      [
        '<div>',
        '  <p>',
        '    Hi <strong>{{Name}}</strong>, welcome.',
        '  </p>',
        '  <ul>',
        '    <li>',
        '      One',
        '    </li>',
        '    <li>',
        '      Two <a href="#">link</a>',
        '    </li>',
        '  </ul>',
        '</div>',
      ].join('\n')
    );
  });

  it('never changes the rendered structure', () => {
    const input = '<table style="width:100%"><tr><td>a<br>b</td><td><img src="x.png" alt="y > z"></td></tr></table><p>  spaced   text </p>';
    expect(squash(formatHtml(input))).toBe(squash(input));
  });

  it('keeps pre, script, style and textarea verbatim', () => {
    const input = '<div><pre>  keep\n   this </pre><style>p{color:red}\n.x>span{}</style><textarea> a\n b</textarea></div>';
    const out = formatHtml(input);
    expect(out).toContain('<pre>  keep\n   this </pre>');
    expect(out).toContain('<style>p{color:red}\n.x>span{}</style>');
    expect(out).toContain('<textarea> a\n b</textarea>');
  });

  it('handles void and self-closing tags without indenting after them', () => {
    expect(formatHtml('<div><hr><hr/><p>x<br>y</p></div>')).toBe('<div>\n  <hr>\n  <hr/>\n  <p>\n    x<br>y\n  </p>\n</div>');
  });

  it('places comments on their own line and tolerates unclosed tags', () => {
    expect(formatHtml('<div><!-- note --><p>a</div>')).toBe('<div>\n  <!-- note -->\n  <p>\n    a\n</div>');
  });

  it('is idempotent', () => {
    const input = '<div><p>Hi <b>x</b></p><p>y</p></div>';
    const once = formatHtml(input);
    expect(formatHtml(once)).toBe(once);
  });

  it('formats a single-line AI email into many lines', () => {
    const ai = '<p style="font-family: Segoe UI; color: #2d3748">Dear {{Name}},</p><p>Reminder about <strong>today</strong>.</p><div style="border-left: 4px solid #3182ce"><ul><li>Join early.</li><li>Stable internet.</li></ul></div><p>Warm regards,<br><strong>Masai Placements</strong></p>';
    const out = formatHtml(ai);
    expect(out.split('\n').length).toBeGreaterThan(10);
    expect(squash(out)).toBe(squash(ai));
  });
});

describe('looksMinified', () => {
  it('flags long single-line HTML and not normal multi-line HTML', () => {
    expect(looksMinified('<p>' + 'x'.repeat(500) + '</p>')).toBe(true);
    expect(looksMinified(Array.from({ length: 20 }, () => '<p>' + 'x'.repeat(30) + '</p>').join('\n'))).toBe(false);
    expect(looksMinified('<p>short</p>')).toBe(false);
  });
});
