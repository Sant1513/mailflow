import { describe, expect, it } from 'vitest';
import { bodyOf, htmlToText, isFullDocument, textToHtml } from '@/lib/editor/convert';

describe('plain text → HTML (Simple to Rich / HTML)', () => {
  it('a blank line starts a paragraph, a single line break stays a line break', () => {
    expect(textToHtml('Hi {{Name}},\n\nLine one\nLine two\n\nRegards')).toBe('<p>Hi {{Name}},</p>\n<p>Line one<br>Line two</p>\n<p>Regards</p>');
  });
  it('escapes characters that mean something in HTML, and keeps merge fields as they are', () => {
    expect(textToHtml('5 < 6 & 7 > 3 {{Company}}')).toBe('<p>5 &lt; 6 &amp; 7 &gt; 3 {{Company}}</p>');
  });
  it('an empty message stays empty', () => {
    expect(textToHtml('  \n ')).toBe('');
  });
});

describe('HTML → plain text (Rich / HTML to Simple)', () => {
  it('paragraphs and line breaks become new lines; formatting tags are dropped', () => {
    expect(htmlToText('<p>Hi <b>{{Name}}</b>,</p><p>Line one<br>Line two</p>')).toBe('Hi {{Name}},\n\nLine one\nLine two');
  });
  it('keeps a link’s address next to its words, lists as bullets, and decodes entities', () => {
    expect(htmlToText('<p>See <a href="https://masai.com/drive">the drive</a> &amp; apply</p><ul><li>One</li><li>Two</li></ul>')).toBe('See the drive (https://masai.com/drive) & apply\n\n• One\n• Two');
  });
  it('a designed email keeps only its content, not its styles', () => {
    expect(htmlToText('<!DOCTYPE html><html><head><style>p{color:red}</style><title>x</title></head><body><p>Hello</p></body></html>')).toBe('Hello');
  });
});

describe('a full designed email', () => {
  const doc = '<!DOCTYPE html>\n<html><head><meta charset="UTF-8"><style>p{margin:0}</style></head><body style="margin:0"><div>Content</div></body></html>';
  it('is recognised (the visual editor must not take it over silently)', () => {
    expect(isFullDocument(doc)).toBe(true);
    expect(isFullDocument('<p>Just a paragraph</p><table><tr><td>cell</td></tr></table>')).toBe(false);
  });
  it('gives back its body content', () => {
    expect(bodyOf(doc)).toBe('<div>Content</div>');
    expect(bodyOf('<style>a{}</style><p>No body tag</p>')).toBe('<p>No body tag</p>');
  });
});
