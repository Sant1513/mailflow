import { describe, expect, it } from 'vitest';
import { sanitizeSigningHtml } from '@/lib/signing/sanitize';

// Shaped like the Word/Google Doc importer's output (lib/signing/docx/convert.ts).
const IMPORTED = [
  '<style>@import url("https://fonts.googleapis.com/css2?family=Inter"); .mf-doc > p { margin: 0 }</style>',
  '<div class="mf-doc" data-mf-page="794 1123 96 96 96 96" style="font-family:Calibri,sans-serif;font-size:11pt">',
  '<p style="margin:0 0 8px;text-align:center"><span style="font-weight:700;color:#2F5496">Offer Letter</span></p>',
  '<p>Dear {{student_name}},</p>',
  '<table style="border-collapse:collapse;width:100%"><colgroup><col style="width:40%"><col style="width:60%"></colgroup>',
  '<tbody><tr style="height:20px"><td colspan="2" style="border:1px solid #000">Role: {{role}}</td></tr></tbody></table>',
  '<ul><li>Joining on {{date}}</li></ul>',
  '<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo" style="width:120px">',
  '<p><a href="https://masaischool.com">Masai</a> · <a href="{{offer_link}}">Offer</a></p>',
  '<div data-signature-slot="2">[[signature:2]]</div>',
  '</div>',
].join('');

describe('sanitizeSigningHtml', () => {
  it('keeps everything an imported document needs', () => {
    const out = sanitizeSigningHtml(IMPORTED);
    expect(out).toContain('<style>');
    expect(out).toContain('.mf-doc > p { margin: 0 }'); // CSS selectors survive unescaped
    expect(out).toContain('data-mf-page="794 1123 96 96 96 96"');
    expect(out).toContain('style="font-weight:700;color:#2F5496"');
    expect(out).toContain('<col style="width:40%" />');
    expect(out).toContain('colspan="2"');
    expect(out).toContain('{{student_name}}');
    expect(out).toContain('href="{{offer_link}}"');
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(out).toContain('[[signature:2]]');
    expect(out).toContain('data-signature-slot="2"');
    expect(out).toContain('href="https://masaischool.com"');
  });

  it('removes script, event handlers, frames and javascript: links', () => {
    const out = sanitizeSigningHtml(
      '<p onclick="steal()">Hi</p><img src=x onerror="fetch(\'/api/admin/users\')"><script>alert(1)</script>' +
        '<iframe src="http://localhost:3200/"></iframe><object data="x"></object><embed src="y">' +
        '<a href="javascript:alert(1)">x</a><form action="/x"><input name="a"></form><svg onload="x()"></svg>',
    );
    expect(out).not.toMatch(/onclick|onerror|onload/i);
    expect(out).not.toMatch(/<script|alert\(1\)|<iframe|<object|<embed|<form|<input|<svg/i);
    expect(out).not.toContain('javascript:');
    expect(out).toContain('<p>Hi</p>');
  });

  it('is stable: sanitising twice changes nothing', () => {
    const once = sanitizeSigningHtml(IMPORTED);
    expect(sanitizeSigningHtml(once)).toBe(once);
  });
});
