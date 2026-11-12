import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmailViewer, LivePreview, Pager, SendSummary, WhoReceives } from '@/components/recruiter-send/RecruiterPreview';
import { assignMailboxes } from '@/lib/recruiterSend/plan';
import { previewHtml } from '@/lib/recruiterSend/core';

describe('recruiter send previews', () => {
  it('shows the envelope — From, To, CC, Bcc, Reply-To, Subject — beside the email', () => {
    const html = renderToStaticMarkup(
      <LivePreview
        html="<p>Hello hiring team</p>"
        envelope={{ mode: 'BCC', fromName: 'Masai Placements', fromEmail: 'one@masaischool.com', toAddress: 'placements@masaischool.com', ccAddresses: ['lead@masaischool.com'], replyTo: 'hr@masaischool.com', subject: 'Hiring partners 2026', perEmail: 250, attachments: ['Brochure.pdf'] }}
      />,
    );
    for (const text of ['Masai Placements', 'one@masaischool.com', 'placements@masaischool.com', 'CC:', 'lead@masaischool.com', 'up to 250 recruiters', 'hr@masaischool.com', 'Hiring partners 2026', 'Brochure.pdf', 'Phone']) {
      expect(html).toContain(text);
    }
  });

  it('lists who receives it, their batch and mailbox, or why they are skipped', () => {
    const html = renderToStaticMarkup(
      <WhoReceives
        plan={{
          people: [
            { email: 'a@corp.com', name: 'Priya', batch: 1, mailbox: 'one@masaischool.com', skipped: null },
            { email: 'bad@nomail.zz', name: null, batch: null, mailbox: null, skipped: 'domain has no mail server' },
            { email: 'c@corp.com', name: null, batch: 2, mailbox: null, skipped: null },
          ],
          peopleTotal: 3, peoplePage: 1, peoplePages: 1,
          batches: [{ seq: 1, size: 1, mailbox: 'one@masaischool.com' }, { seq: 2, size: 1, mailbox: null }],
          batchesTotal: 2, batchPage: 1, batchPages: 1, batchFirst: { 1: 'a@corp.com', 2: 'c@corp.com' },
        }}
        byMailbox={[{ mailbox: 'one@masaischool.com', emails: 1, recruiters: 1 }, { mailbox: null, emails: 1, recruiters: 1 }]}
        total={3}
        html="<p>Hi</p>"
        subject="Hiring partners"
        mode="BCC"
      />,
    );
    expect(html).toContain('Who receives this');
    expect(html).toContain('Whose account sends it');
    expect(html).toContain('Will get it');
    expect(html).toContain('domain has no mail server');
    expect(html).toContain('Later (daily allowance used up)');
    expect(html).toContain('Batches (2 emails)');
    expect(html).toContain('#1');
    expect(html).toContain('later — allowance used up');
  });

  it('pages long lists and hides the pager when one page is enough', () => {
    const html = renderToStaticMarkup(<Pager page={2} pages={5} onPage={() => undefined} />);
    expect(html).toContain('Page 2 of 5');
    expect(html).toContain('Next');
    expect(renderToStaticMarkup(<Pager page={1} pages={1} onPage={() => undefined} />)).toBe('');
  });

  it('lets the email viewer be sized: Desktop / Phone, a width slider, a draggable height', () => {
    const html = renderToStaticMarkup(<EmailViewer html="<p>Hi</p>" storageKey="t" />);
    expect(html).toContain('type="range"');
    expect(html).toContain('resize:vertical');
    expect(html).toContain('Phone');
    expect(html).toContain('Reset');
  });

  it('shows the page the server sent, with the pager, a jump box and no "first 2,000" note', () => {
    const people = Array.from({ length: 50 }, (_, i) => ({ email: `r${i}@corp.com`, name: null, batch: 1, mailbox: 'one@x.com', skipped: null }));
    const html = renderToStaticMarkup(
      <WhoReceives
        plan={{ people, peopleTotal: 3001, peoplePage: 1, peoplePages: 61, peoplePageSize: 50, batches: [{ seq: 1, size: 250, mailbox: 'one@x.com' }], batchesTotal: 13, batchPage: 1, batchPages: 1, batchFirst: { 1: 'r0@corp.com' } }}
        byMailbox={[{ mailbox: 'one@x.com', emails: 13, recruiters: 3001 }]}
        total={3001} html="<p>Hi</p>" subject="S" mode="BCC" blastId="b1"
      />,
    );
    expect(html).toContain('r49@corp.com');
    expect(html).toContain('Page 1 of 61');
    expect(html).toContain('Go to');
    expect(html).toContain('Search email or name');
    expect(html).toContain('Batches (13 emails)');
    expect(html).toContain('3,001 recruiters');
    expect(html).not.toContain('The plan lists the first');
  });

  it('adds a jump-to-page box to the pager on request', () => {
    expect(renderToStaticMarkup(<Pager page={3} pages={61} onPage={() => undefined} jump />)).toContain('aria-label="Page number"');
    expect(renderToStaticMarkup(<Pager page={3} pages={61} onPage={() => undefined} />)).not.toContain('Page number');
  });

  it('shows the review card with every setting and its warnings', () => {
    const html = renderToStaticMarkup(<SendSummary items={[['Batches', '3 emails'], ['CC', 'lead@masaischool.com'], ['Sending accounts (in order)', '1. one@x.com (limit 500)']]} warnings={['Add a subject.']} />);
    for (const t of ['Review before sending', '3 emails', 'lead@masaischool.com', '1. one@x.com (limit 500)', 'Add a subject.']) expect(html).toContain(t);
  });

  it("plans batches onto mailboxes like the sender: in order, within the send's limit and today's allowance", () => {
    const plan = assignMailboxes([250, 250, 250, 100], [
      { emailAddress: 'one@x.com', messagesLeft: 100, peopleLeft: 1800, sendLimit: 500 },
      { emailAddress: 'two@x.com', messagesLeft: 1, peopleLeft: 1800, sendLimit: null },
    ]);
    expect(plan).toEqual(['one@x.com', 'one@x.com', 'two@x.com', null]);
  });

  it('previews never carry the open pixel, but do show the unsubscribe line', () => {
    const html = previewHtml({ id: 'b1', html: '<html><body><p>Hi</p></body></html>', mode: 'BCC', workspaceId: 'w1' });
    expect(html).toContain('Unsubscribe');
    expect(html).not.toContain('/api/track/rb/');
  });
});
