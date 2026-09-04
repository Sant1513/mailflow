import { describe, it, expect } from 'vitest';
import {
  extractVariables,
  renderTemplate,
  validateVariables,
  escapeHtml,
  htmlToPlainText,
} from '@/lib/templates/variables';

describe('extractVariables', () => {
  it('finds variables across subject, html and plain text', () => {
    expect(
      extractVariables('Hi {{Name}}', '<p>Code: {{Code}}</p>', 'Deadline {{Deadline}}')
    ).toEqual(['Code', 'Deadline', 'Name']);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(extractVariables('{{ Name }}')).toEqual(['Name']);
  });

  it('de-duplicates repeated variables', () => {
    expect(extractVariables('{{Name}} {{Name}} {{Name}}')).toEqual(['Name']);
  });

  it('ignores malformed or non-identifier placeholders', () => {
    expect(extractVariables('{{ }} {{123}} {single} {{a-b}}')).toEqual([]);
  });
});

describe('renderTemplate', () => {
  const template = {
    subject: 'Reminder for {{Name}} — due {{Deadline}}',
    html: '<p>Hi {{Name}}, your code is {{Code}}.</p>',
    plainText: 'Hi {{Name}}, your code is {{Code}}.',
  };

  it('substitutes values into subject, html and plain text', () => {
    const out = renderTemplate(template, { Name: 'Rahul', Code: 'fd41', Deadline: '16 April 2025' });
    expect(out.subject).toBe('Reminder for Rahul — due 16 April 2025');
    expect(out.html).toBe('<p>Hi Rahul, your code is fd41.</p>');
    expect(out.plainText).toBe('Hi Rahul, your code is fd41.');
    expect(out.missingVariables).toEqual([]);
  });

  it('reports missing variables rather than silently blanking them', () => {
    const out = renderTemplate(template, { Name: 'Rahul' });
    expect(out.missingVariables).toEqual(['Code', 'Deadline']);
  });

  it('treats an empty-string value as missing (nothing would reach the student)', () => {
    const out = renderTemplate({ subject: '{{Name}}', html: '' }, { Name: '' });
    expect(out.missingVariables).toEqual(['Name']);
  });

  it('HTML-escapes substituted values so data cannot inject markup', () => {
    const out = renderTemplate(
      { subject: 'x', html: '<p>{{Name}}</p>' },
      { Name: '<script>alert(1)</script>' }
    );
    expect(out.html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(out.html).not.toContain('<script>');
  });

  it('escapes quotes so a value cannot break out of an HTML attribute', () => {
    const out = renderTemplate(
      { subject: 'x', html: '<a href="/u/{{Id}}">link</a>' },
      { Id: '" onmouseover="alert(1)' }
    );
    expect(out.html).not.toContain('onmouseover="alert(1)"');
    expect(out.html).toContain('&quot;');
  });

  it('does NOT html-escape the subject (it is a plain-text header)', () => {
    const out = renderTemplate({ subject: 'Results for {{Name}}', html: '' }, { Name: 'A & B' });
    expect(out.subject).toBe('Results for A & B');
  });

  it('renders booleans and dates readably', () => {
    const out = renderTemplate(
      { subject: '{{Flag}}', html: '<p>{{When}}</p>' },
      { Flag: true, When: new Date('2026-04-16T00:00:00Z') }
    );
    expect(out.subject).toBe('Yes');
    expect(out.html).toContain('2026-04-16');
  });

  it('is deterministic — same input always gives identical output', () => {
    const data = { Name: 'Rahul', Code: 'fd41', Deadline: '16 April' };
    expect(renderTemplate(template, data)).toEqual(renderTemplate(template, data));
  });
});

describe('validateVariables', () => {
  it('passes when every referenced variable exists as a column', () => {
    const result = validateVariables(
      { subject: 'Hi {{Name}}', html: '<p>{{Code}}</p>' },
      ['Name', 'Code', 'Email']
    );
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unused).toEqual(['Email']);
  });

  it('fails, listing the missing variable — this is what blocks a send (§24)', () => {
    const result = validateVariables(
      { subject: 'Hi {{StudentName}}', html: '' },
      ['Name', 'Email']
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['StudentName']);
  });
});

describe('escapeHtml', () => {
  it('escapes all five dangerous characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('htmlToPlainText', () => {
  it('strips tags and drops script/style content entirely', () => {
    const text = htmlToPlainText('<style>p{color:red}</style><p>Hello</p><script>evil()</script><p>World</p>');
    expect(text).toBe('Hello\n\nWorld');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('color:red');
  });

  it('turns <br> into newlines and decodes entities', () => {
    expect(htmlToPlainText('A&nbsp;&amp;&nbsp;B<br>C')).toBe('A & B\nC');
  });
});
