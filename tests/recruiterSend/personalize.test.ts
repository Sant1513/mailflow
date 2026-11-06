import { describe, expect, it } from 'vitest';
import { buildBody, looksLikeTable, parseRecipientPaste, parseRecipientFile } from '@/lib/recruiterSend/core';
import { missingValues, personalize, variableCheck, variablesIn } from '@/lib/recruiterSend/personalize';

const TAB = '\t';
const sheet = [
  ['Recruiter Name', 'Email ID', 'Company', 'UTM link'].join(TAB),
  ['Priya Sharma', 'Priya@Acme.com', 'Acme & Co', 'https://masai.link/hire?utm_source=acme&utm_campaign=drive'].join(TAB),
  ['Rahul', 'rahul@corp.in', 'Corp', ''].join(TAB),
  ['No address', '', 'Nowhere', ''].join(TAB),
  ['Priya again', 'priya@acme.com', 'Dup', ''].join(TAB),
].join('\n');

describe('recruiter list with columns', () => {
  it('a pasted sheet keeps every column and finds the email column', () => {
    expect(looksLikeTable(sheet)).toBe(true);
    const list = parseRecipientPaste(sheet);
    expect(list.columns).toEqual(['Recruiter Name', 'Email ID', 'Company', 'UTM link']);
    expect(list.emailColumn).toBe('Email ID');
    expect(list.recipients.map((r) => r.email)).toEqual(['priya@acme.com', 'rahul@corp.in']);
    expect(list.recipients[0]!.name).toBe('Priya Sharma');
    expect(list.recipients[0]!.data!['UTM link']).toContain('utm_source=acme');
    expect(list.unreadable).toHaveLength(1);
  });

  it('plain address lists still work as before', () => {
    const list = parseRecipientPaste('priya@company.com\nRahul Mehta <rahul@corp.in>');
    expect(list.columns).toEqual([]);
    expect(list.recipients).toEqual([
      { email: 'priya@company.com', name: null },
      { email: 'rahul@corp.in', name: 'Rahul Mehta' },
    ]);
  });

  it('the email column can be chosen when the guess is wrong', () => {
    const csv = 'Name,Work,Personal\nA,a@work.com,a@home.com\n';
    expect(parseRecipientFile(Buffer.from(csv), 'x.csv').emailColumn).toBe('Work');
    const chosen = parseRecipientFile(Buffer.from(csv), 'x.csv', 'Personal');
    expect(chosen.emailColumn).toBe('Personal');
    expect(chosen.recipients[0]!.email).toBe('a@home.com');
  });

  it('a table with no address column says so', () => {
    const list = parseRecipientPaste('Name,Company\nA,B\nC,D');
    expect(list.error).toMatch(/No column of email addresses/);
  });
});

describe('{{Column}} personalisation', () => {
  const priya = { email: 'priya@acme.com', name: 'Priya Sharma', data: { 'Recruiter Name': 'Priya Sharma', 'Email ID': 'priya@acme.com', Company: 'Acme & Co', 'UTM link': 'https://masai.link/hire?utm_source=acme&utm_campaign=drive' } };

  it('fills subject, text and links with loose names', () => {
    const built = buildBody({ body: 'Hi {{First name}},\n\nFor {{company}}: {{UTM Link}}', format: 'text', signature: null });
    const out = personalize({ subject: 'Hiring at {{Company}}', ...built }, priya);
    expect(out.subject).toBe('Hiring at Acme & Co');
    expect(out.html).toContain('Hi Priya,');
    expect(out.html).toContain('For Acme &amp; Co:');
    // A link value in the text becomes clickable, with its parameters intact.
    expect(out.html).toContain('<a href="https://masai.link/hire?utm_source=acme&amp;utm_campaign=drive">');
    expect(out.plainText).toContain('https://masai.link/hire?utm_source=acme&utm_campaign=drive');
  });

  it('keeps href="{{UTM link}}" working through HTML mode (CSS inlining included)', () => {
    const built = buildBody({ body: '<style>a{color:red}</style><p>Hi {{Name}}, <a href="{{UTM link}}">apply here</a></p>', format: 'html', signature: null });
    const out = personalize({ subject: 's', ...built }, priya);
    expect(out.html).toMatch(/href="https:\/\/masai\.link\/hire\?utm_source=acme&amp;utm_campaign=drive"/);
    expect(out.html).toContain('>apply here</a>');
    expect(out.html).not.toContain('{{');
  });

  it('escapes values so a list cannot inject markup', () => {
    const out = personalize({ subject: '{{Company}}', html: '<p>{{Company}}</p>', plainText: '' }, { email: 'x@y.com', name: null, data: { Company: '<script>x</script>' } });
    expect(out.html).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
  });

  it('fallbacks fill empty values; without one the recruiter is reported missing', () => {
    const rahul = { email: 'rahul@corp.in', name: 'Rahul', data: { Company: 'Corp', 'UTM link': '' } };
    const content = { subject: 'Hi {{Name | there}}', html: '<a href="{{UTM link}}">x</a> {{Title | Hiring Manager}}', plainText: '' };
    expect(missingValues(content, rahul)).toEqual(['UTM link']);
    expect(missingValues(content, priya)).toEqual([]);
    const out = personalize(content, { email: 'a@b.com', name: null, data: {} });
    expect(out.subject).toBe('Hi there');
  });

  it('unknown variables and BCC are caught before sending', () => {
    const cols = ['Company', 'UTM link'];
    expect(variableCheck({ subject: '{{Company}}', html: '{{Salary}}', mode: 'INDIVIDUAL', columns: cols })).toEqual({ used: ['Company', 'Salary'], unknown: ['Salary'], bccConflict: false });
    expect(variableCheck({ subject: 'Hi {{Name}}', html: '', mode: 'BCC', columns: [] }).bccConflict).toBe(true);
    expect(variableCheck({ subject: 'No variables', html: '<p>x</p>', mode: 'BCC', columns: [] })).toEqual({ used: [], unknown: [], bccConflict: false });
  });

  it('lists variables once, by first spelling', () => {
    expect(variablesIn('{{UTM link}} {{utm_link}}', '{{Name|x}}')).toEqual([
      { name: 'UTM link', fallback: false },
      { name: 'Name', fallback: true },
    ]);
  });
});
