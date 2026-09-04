import { describe, it, expect } from 'vitest';
import { htmlToPlainText } from '@/lib/templates/variables';
import { latestVersionOf } from '@/lib/templates/access';

/**
 * Regression cover for the "unchanged save still created a new version" bug.
 *
 * The versions route auto-generates `plainText` from the HTML when the
 * client doesn't send one (the editor never does). The bug was comparing
 * the STORED generated value against the raw incoming `null`, so a save with
 * genuinely identical content always looked like a change — every save in
 * the editor would have bumped the version number, polluting the history
 * that §21/§126 rely on.
 *
 * These tests pin the comparison rule the route now implements.
 */
function resolvePlainText(body: { html: string; plainText?: string | null }): string | null {
  return body.plainText ?? (body.html ? htmlToPlainText(body.html) : null);
}

function isUnchanged(
  latest: { subject: string; html: string; css: string | null; plainText: string | null },
  body: { subject: string; html: string; css?: string | null; plainText?: string | null }
): boolean {
  return (
    latest.subject === body.subject &&
    latest.html === body.html &&
    (latest.css ?? null) === (body.css ?? null) &&
    (latest.plainText ?? null) === resolvePlainText(body)
  );
}

const html = '<p>Updated {{Name}}</p>';
const stored = {
  subject: 'Reminder for {{Name}}',
  html,
  css: null,
  plainText: htmlToPlainText(html), // what the server generated on the last save
};

describe('template version de-duplication', () => {
  it('treats a re-save with no plainText as UNCHANGED (the regression)', () => {
    expect(isUnchanged(stored, { subject: stored.subject, html })).toBe(true);
  });

  it('treats a re-save with the same explicit plainText as unchanged', () => {
    expect(isUnchanged(stored, { subject: stored.subject, html, plainText: stored.plainText })).toBe(true);
  });

  it('detects a changed subject', () => {
    expect(isUnchanged(stored, { subject: 'Different', html })).toBe(false);
  });

  it('detects changed html', () => {
    expect(isUnchanged(stored, { subject: stored.subject, html: '<p>Other</p>' })).toBe(false);
  });

  it('detects newly added css', () => {
    expect(isUnchanged(stored, { subject: stored.subject, html, css: 'p{color:red}' })).toBe(false);
  });

  it('detects a hand-edited plainText that differs from the generated one', () => {
    expect(isUnchanged(stored, { subject: stored.subject, html, plainText: 'Hand written' })).toBe(false);
  });
});

describe('latestVersionOf', () => {
  it('returns the highest version number regardless of array order', () => {
    const versions = [{ version: 2 }, { version: 5 }, { version: 1 }];
    expect(latestVersionOf(versions)?.version).toBe(5);
  });

  it('returns null for a template with no versions', () => {
    expect(latestVersionOf([])).toBeNull();
  });
});
