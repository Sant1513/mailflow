import { describe, it, expect } from 'vitest';
import { quotedHtmlStart, quotedTextStart, splitMessageBody, textToHtml } from '@/lib/conversations/messageView';

describe('quotedHtmlStart', () => {
  it('finds Gmail, Outlook, Apple Mail, Yahoo and Thunderbird quote blocks', () => {
    expect(quotedHtmlStart('<p>Thanks!</p><div class="gmail_quote">…</div>')).toBe(14);
    expect(quotedHtmlStart('<p>ok</p><div id="divRplyFwdMsg">From: x</div>')).toBe(9);
    expect(quotedHtmlStart('<p>ok</p><blockquote type="cite">old</blockquote>')).toBe(9);
    expect(quotedHtmlStart('<p>ok</p><div class="yahoo_quoted">x</div>')).toBe(9);
    expect(quotedHtmlStart('<p>ok</p><div class="moz-cite-prefix">On … wrote:</div>')).toBe(9);
  });

  it('falls back to "On … wrote:" followed by a blockquote', () => {
    const html = '<div>Done</div><div>On Fri, 5 Sep 2026, Team wrote:<br><blockquote>Please complete</blockquote></div>';
    expect(quotedHtmlStart(html)).toBe('<div>Done</div>'.length);
  });

  it('returns -1 when there is no quote', () => {
    expect(quotedHtmlStart('<p>Just a message with a <blockquote>real quote</blockquote> in it</p>')).toBe(-1);
  });
});

describe('quotedTextStart', () => {
  it('detects "On … wrote:", ">" lines, Outlook headers and signatures', () => {
    expect(quotedTextStart('Done!\n\nOn Fri, Team wrote:\n> hi')).toBe(7);
    expect(quotedTextStart('Sure.\n> old line')).toBe(6);
    expect(quotedTextStart('ok\nFrom: Someone\nSent: x')).toBe(3);
    expect(quotedTextStart('ok\nSent from my iPhone')).toBe(3);
    expect(quotedTextStart('nothing quoted here')).toBe(-1);
  });
});

describe('textToHtml', () => {
  it('escapes, paragraphs, line breaks and links', () => {
    expect(textToHtml('a <b>\nb\n\nsee https://masaischool.com/x.')).toBe(
      '<p>a &lt;b&gt;<br>b</p>\n<p>see <a href="https://masaischool.com/x" target="_blank" rel="noopener noreferrer">https://masaischool.com/x</a>.</p>'
    );
  });
});

describe('splitMessageBody', () => {
  it('prefers sanitised HTML and splits the quoted history off', () => {
    const r = splitMessageBody({ htmlBody: '<p>Done <script>alert(1)</script>with RPG</p><div class="gmail_quote">On x wrote: …</div>', plainTextBody: 'Done' });
    expect(r.main).toBe('<p>Done with RPG</p>');
    expect(r.quoted).toContain('gmail_quote');
    expect(r.main).not.toContain('script');
  });

  it('keeps everything as main when only a quote would remain', () => {
    const r = splitMessageBody({ htmlBody: '<div class="gmail_quote">only a quote</div>' });
    expect(r.quoted).toBeNull();
    expect(r.main).toContain('only a quote');
  });

  it('converts plain text with quotes collapsed', () => {
    const r = splitMessageBody({ plainTextBody: 'Thanks, done.\n\nOn Mon, Team wrote:\n> Please complete' });
    expect(r.main).toBe('<p>Thanks, done.</p>');
    expect(r.quoted).toContain('&gt; Please complete');
  });

  it('falls back to the snippet and then to a placeholder', () => {
    expect(splitMessageBody({ snippet: 'just a snippet' }).main).toBe('<p>just a snippet</p>');
    expect(splitMessageBody({}).main).toContain('(no text)');
  });

  it('renders the raw-template mistake from the screenshot as text, not as broken markup', () => {
    // A user pasted template code into a plain-text reply; it arrived as plain text.
    const r = splitMessageBody({ plainTextBody: '</div>`;{{Code}}{{Deadline}}' });
    expect(r.main).toBe('<p>&lt;/div&gt;`;{{Code}}{{Deadline}}</p>');
  });
});
