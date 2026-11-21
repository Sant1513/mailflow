/**
 * One key per person, so the same inbox written two ways counts once: lower case, and for Gmail the dots and any "+tag"
 * are ignored (a.b@gmail.com, ab@gmail.com and ab+news@gmail.com are one inbox; googlemail.com is Gmail).
 * Other providers keep their dots: on a company domain "a.b" and "ab" can be different people.
 * Mirrors the database function mailflow_email_key() (see the migration), which the indexes use; the QA script checks they agree.
 */
export function emailKey(email: string | null | undefined): string {
  const e = (email ?? '').trim().toLowerCase();
  const at = e.indexOf('@');
  if (at < 0) return e;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') return `${local.split('+')[0]!.replace(/\./g, '')}@gmail.com`;
  return e;
}
