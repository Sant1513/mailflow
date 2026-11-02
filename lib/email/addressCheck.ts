import { promises as dns } from 'node:dns';
import { prisma } from '@/lib/db/client';

/**
 * Pre-send address check (campaign review, simulation, the real send, Quick Send). Catches the
 * addresses that would only bounce or be wasted, before they cost sender reputation:
 *   - already unsubscribed or bounced (the suppression list),
 *   - a domain that can't receive email (no mail server in DNS),
 *   - an obvious typo of a big provider (gmial.com → gmail.com),
 *   - no-reply / system addresses, and throwaway (disposable) inboxes.
 * Checks never block on a slow or failing DNS server: an inconclusive lookup lets the
 * address through.
 */

export type AddressProblemKind = 'SUPPRESSED' | 'NO_MAIL_SERVER' | 'LIKELY_TYPO' | 'NO_REPLY_ADDRESS' | 'DISPOSABLE';
export interface AddressProblem {
  kind: AddressProblemKind;
  detail: string;
}

// Typos of the providers most of our students use, mapped to the intended domain.
const TYPO_DOMAINS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmai.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.om': 'gmail.com',
  'gmil.com': 'gmail.com', 'gmail.comm': 'gmail.com', 'gmali.com': 'gmail.com', 'gmaul.com': 'gmail.com', 'gimail.com': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yhoo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yahho.com': 'yahoo.com',
  'yahoo.co': 'yahoo.co.in', 'yaho.co.in': 'yahoo.co.in', 'yahoo.in': 'yahoo.co.in',
  'hotmal.com': 'hotmail.com', 'hotmial.com': 'hotmail.com', 'homail.com': 'hotmail.com', 'hotmail.co': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outllok.com': 'outlook.com', 'outlook.co': 'outlook.com', 'outlook.con': 'outlook.com', 'oulook.com': 'outlook.com',
  'rediffmail.co': 'rediffmail.com', 'redifmail.com': 'rediffmail.com', 'rediffmial.com': 'rediffmail.com',
  'icloud.co': 'icloud.com', 'iclod.com': 'icloud.com', 'icoud.com': 'icloud.com',
};

const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)([+._-].*)?@/i;

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com',
  'emailondeck.com', 'mohmal.com', 'tempmailo.com', 'burnermail.io',
]);

/** Checks that need no network. */
export function staticAddressProblem(email: string): AddressProblem | null {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (NO_REPLY.test(email)) return { kind: 'NO_REPLY_ADDRESS', detail: `"${email}" is a no-reply/system address; nobody reads it.` };
  const fix = TYPO_DOMAINS[domain] ?? (/\.(con|cmo|ocm|comm)$/.test(domain) ? domain.replace(/\.(con|cmo|ocm|comm)$/, '.com') : null);
  if (fix) return { kind: 'LIKELY_TYPO', detail: `"${domain}" looks like a typo of "${fix}". Correct the address in the data.` };
  if (DISPOSABLE.has(domain)) return { kind: 'DISPOSABLE', detail: `"${domain}" is a throwaway inbox service.` };
  return null;
}

// Domain → can it receive mail? Cached for an hour per server instance.
const domainCache = new Map<string, { ok: boolean | null; at: number }>();
const DOMAIN_TTL_MS = 3_600_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

/** true = receives mail, false = definitely doesn't, null = couldn't tell (treated as fine). */
export async function domainAcceptsMail(domain: string): Promise<boolean | null> {
  const cached = domainCache.get(domain);
  if (cached && Date.now() - cached.at < DOMAIN_TTL_MS) return cached.ok;
  let ok: boolean | null;
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 4000);
    // A "null MX" (RFC 7505: priority 0, exchange ".") means the domain explicitly takes no mail.
    ok = mx.some((r) => r.exchange && r.exchange !== '.');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      // No MX: mail falls back to the domain's own address record (RFC 5321 §5.1).
      try {
        const a = await withTimeout(dns.resolve4(domain), 4000);
        ok = a.length > 0;
      } catch (e2) {
        const c2 = (e2 as NodeJS.ErrnoException).code;
        ok = c2 === 'ENOTFOUND' || c2 === 'ENODATA' ? false : null;
      }
    } else ok = null; // timeout / server failure: inconclusive
  }
  domainCache.set(domain, { ok, at: Date.now() });
  return ok;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++] as T);
  }));
}

/**
 * Problems for the given addresses (lower-cased keys), in a workspace. Addresses not in the
 * map are fine. `dnsCheck: false` skips the network lookups (unit tests, very large lists).
 */
export async function checkAddresses(
  emails: string[],
  workspaceId: string | null,
  options: { dnsCheck?: boolean } = {},
): Promise<Map<string, AddressProblem>> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];
  const problems = new Map<string, AddressProblem>();

  if (workspaceId && unique.length) {
    for (let i = 0; i < unique.length; i += 1000) {
      const rows = await prisma.emailSuppression.findMany({
        where: { workspaceId, email: { in: unique.slice(i, i + 1000), mode: 'insensitive' } },
        select: { email: true, reason: true, detail: true },
      });
      for (const r of rows) {
        const why = r.reason === 'BOUNCED' ? 'bounced before' : r.reason === 'COMPLAINT' ? 'reported a previous email as spam' : 'unsubscribed';
        problems.set(r.email.toLowerCase(), { kind: 'SUPPRESSED', detail: `This address ${why}${r.detail && r.reason === 'BOUNCED' ? ` (${r.detail.slice(0, 120)})` : ''}.` });
      }
    }
  }

  for (const email of unique) {
    if (problems.has(email)) continue;
    const p = staticAddressProblem(email);
    if (p) problems.set(email, p);
  }

  if (options.dnsCheck !== false) {
    const byDomain = new Map<string, string[]>();
    for (const email of unique) {
      if (problems.has(email)) continue;
      const domain = email.slice(email.lastIndexOf('@') + 1);
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), email]);
    }
    await mapLimit([...byDomain.keys()], 10, async (domain) => {
      if ((await domainAcceptsMail(domain)) === false) {
        for (const email of byDomain.get(domain) ?? []) {
          problems.set(email, { kind: 'NO_MAIL_SERVER', detail: `"${domain}" has no mail server, so nothing sent there can arrive.` });
        }
      }
    });
  }
  return problems;
}
