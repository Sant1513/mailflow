import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/email/gmail', () => ({ GmailProvider: class {} }));

const { assignmentSubject, assignmentEmailHtml, resolutionEmailHtml, assignmentSlackText, resolutionSlackText } = await import('@/lib/conversations/notify');
const { mention, esc } = await import('@/lib/slack/client');
const { renderSnippet, snippetVariables } = await import('@/lib/snippets/render');

describe('Slack helpers', () => {
  it('mentions by id when known, names otherwise', () => {
    expect(mention('U04DRTCE9L4', 'Abhishesh')).toBe('<@U04DRTCE9L4>');
    expect(mention('  ', 'Abhishesh')).toBe('Abhishesh');
    expect(mention(null, 'Abhishesh')).toBe('Abhishesh');
  });
  it('escapes mrkdwn control characters', () => {
    expect(esc('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
  });
});

describe('assignment / resolution builders', () => {
  const base = { assigneeName: 'Rahul Kumar', assignerName: 'Abhishesh', subject: 'RPG <clearance>', student: 'Anita', lastLine: 'Anita: done & dusted', url: 'https://x/inbox/c1' };

  it('subject is stable so the decision threads under it', () => {
    expect(assignmentSubject('RPG')).toBe('[MailFlow] Assigned to you: RPG');
    expect(assignmentSubject('')).toBe('[MailFlow] Assigned to you: (no subject)');
  });

  it('assignment email greets by first name, escapes, links', () => {
    const html = assignmentEmailHtml(base);
    expect(html).toContain('Hi Rahul,');
    expect(html).toContain('RPG &lt;clearance&gt;');
    expect(html).toContain('done &amp; dusted');
    expect(html).toContain('href="https://x/inbox/c1"');
    expect(html).not.toContain('<clearance>');
  });

  it('resolution email names the actor and the verb', () => {
    expect(resolutionEmailHtml({ assigneeName: 'Rahul', actorName: 'Abhishesh', subject: 'S', status: 'RESOLVED', url: 'u' })).toContain('resolved');
    expect(resolutionEmailHtml({ assigneeName: 'Rahul', actorName: 'Abhishesh', subject: 'S', status: 'CLOSED', url: 'u' })).toContain('closed');
  });

  it('slack texts mention the assignee, escape, and quote the last line', () => {
    const t = assignmentSlackText({ ...base, assigneeSlackId: 'U1' });
    expect(t.startsWith(':inbox_tray: <@U1> — *Abhishesh* assigned you <https://x/inbox/c1|RPG &lt;clearance&gt;> with Anita.')).toBe(true);
    expect(t).toContain('\n> Anita: done &amp; dusted');
    expect(assignmentSlackText({ ...base, assigneeSlackId: null, lastLine: '' })).not.toContain('\n>');
    expect(resolutionSlackText({ assigneeSlackId: null, assigneeName: 'Rahul', actorName: 'A', subject: 'S', status: 'CLOSED', url: 'u' })).toContain('*closed*');
  });
});

describe('snippets', () => {
  it('exposes Name, FirstName, Email, Sender plus record columns', () => {
    const v = snippetVariables({ contactName: 'Rahul Kumar', contactEmail: 'r@x.com', senderName: 'Abhishesh', record: { Code: 'fd41', Name: 'ignored' } });
    expect(v).toMatchObject({ Name: 'Rahul Kumar', FirstName: 'Rahul', Email: 'r@x.com', Sender: 'Abhishesh', Code: 'fd41' });
  });

  it('resolves known variables (escaped) and leaves unknown ones visible', () => {
    const r = renderSnippet('<p>Hi {{FirstName}} &lt;{{Name}}&gt;, code {{Code}}, by {{Deadline}} — {{ Sender }}</p>', { contactName: 'A <b>', senderName: 'S', record: { Code: '1' } });
    expect(r.html).toBe('<p>Hi A &lt;A &lt;b&gt;&gt;, code 1, by {{Deadline}} — S</p>');
    expect(r.missing).toEqual(['Deadline']);
  });
});
