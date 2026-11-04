import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LivePreview, SendSummary, WhoReceives } from '@/components/recruiter-send/RecruiterPreview';
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
        people={[
          { email: 'a@corp.com', name: 'Priya', batch: 1, mailbox: 'one@masaischool.com', skipped: null },
          { email: 'bad@nomail.zz', name: null, batch: null, mailbox: null, skipped: 'domain has no mail server' },
          { email: 'c@corp.com', name: null, batch: 2, mailbox: null, skipped: null },
        ]}
        batches={[{ seq: 1, size: 1, mailbox: 'one@masaischool.com' }, { seq: 2, size: 1, mailbox: null }]}
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
