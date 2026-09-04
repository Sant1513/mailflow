import { describe, it, expect } from 'vitest';
import { runHealthCheck } from '@/lib/templates/healthCheck';

const good = {
  subject: 'Reminder: RPG Clearance – {{Deadline}}',
  html: '<p>Dear {{Name}}, your code is {{Code}}.</p><a href="https://masaischool.com">Portal</a>',
  plainText: 'Dear {{Name}}, your code is {{Code}}.',
};

function itemFor(result: ReturnType<typeof runHealthCheck>, id: string) {
  return result.items.find((i) => i.id === id);
}

describe('runHealthCheck', () => {
  it('passes a well-formed template with a matching dataset', () => {
    const result = runHealthCheck({
      template: good,
      availableKeys: ['Name', 'Code', 'Deadline', 'Email'],
      hasRecipientColumn: true,
      senderConnected: true,
      senderEmail: 'abhishesh@masaischool.com',
    });
    expect(result.blocked).toBe(false);
    expect(result.failCount).toBe(0);
  });

  it('BLOCKS when the subject is empty', () => {
    const result = runHealthCheck({ template: { ...good, subject: '   ' } });
    expect(itemFor(result, 'subject')?.level).toBe('fail');
    expect(result.blocked).toBe(true);
  });

  it('BLOCKS when the body is empty', () => {
    const result = runHealthCheck({ template: { ...good, html: '' } });
    expect(itemFor(result, 'body')?.level).toBe('fail');
    expect(result.blocked).toBe(true);
  });

  it('BLOCKS when a variable does not exist in the dataset (§24)', () => {
    const result = runHealthCheck({
      template: { subject: 'Hi {{StudentName}}', html: '<p>x</p>' },
      availableKeys: ['Name', 'Email'],
    });
    const item = itemFor(result, 'variables');
    expect(item?.level).toBe('fail');
    expect(item?.detail).toContain('{{StudentName}}');
    expect(result.blocked).toBe(true);
  });

  it('BLOCKS when the dataset has no email column to send to', () => {
    const result = runHealthCheck({ template: good, hasRecipientColumn: false });
    expect(itemFor(result, 'recipient')?.level).toBe('fail');
    expect(result.blocked).toBe(true);
  });

  it('BLOCKS when no sending account is connected (§28)', () => {
    const result = runHealthCheck({ template: good, senderConnected: false });
    expect(itemFor(result, 'sender')?.level).toBe('fail');
    expect(result.blocked).toBe(true);
  });

  it('BLOCKS on unbalanced variable braces — catches the {{Name typo', () => {
    const result = runHealthCheck({ template: { ...good, html: '<p>Hi {{Name</p>' } });
    expect(itemFor(result, 'braces')?.level).toBe('fail');
    expect(result.blocked).toBe(true);
  });

  it('warns (does not block) on links that point nowhere', () => {
    const result = runHealthCheck({
      template: { ...good, html: '<a href="#">click</a>' },
      availableKeys: ['Name', 'Code', 'Deadline'],
    });
    expect(itemFor(result, 'links')?.level).toBe('warn');
    expect(result.blocked).toBe(false);
  });

  it('warns on an image with an empty src', () => {
    const result = runHealthCheck({ template: { ...good, html: '<img src="">' } });
    expect(itemFor(result, 'images')?.level).toBe('warn');
    expect(result.blocked).toBe(false);
  });

  it('warns on http:// images that mail clients often block', () => {
    const result = runHealthCheck({ template: { ...good, html: '<img src="http://x.test/a.png">' } });
    expect(itemFor(result, 'images')?.level).toBe('warn');
  });

  it('warns when there is no plain-text alternative', () => {
    const result = runHealthCheck({ template: { ...good, plainText: null } });
    expect(itemFor(result, 'plaintext')?.level).toBe('warn');
    expect(result.blocked).toBe(false);
  });

  it('warns when the body exceeds the ~102KB Gmail clipping threshold', () => {
    const result = runHealthCheck({ template: { ...good, html: '<p>' + 'x'.repeat(110 * 1024) + '</p>' } });
    expect(itemFor(result, 'size')?.level).toBe('warn');
  });

  it('counts fails and warns separately', () => {
    const result = runHealthCheck({
      template: { subject: '', html: '<a href="#">x</a>', plainText: null },
    });
    expect(result.failCount).toBeGreaterThan(0);
    expect(result.warnCount).toBeGreaterThan(0);
    expect(result.blocked).toBe(true);
  });
});
