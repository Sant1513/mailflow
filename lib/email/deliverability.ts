import { promises as dns } from 'node:dns';
import { EmailJobStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { dailyLimit, usageLast24h, backoffUntil, DAILY_UNIQUE_RECIPIENT_LIMIT } from '@/lib/queue/drain';

/**
 * Deliverability panel (Mail → Deliverability). Google judges every sending mailbox on bounce
 * and spam rates and on domain authentication; this puts those numbers in one place, with
 * the thresholds Google and Yahoo publish for senders:
 *   - authentication: SPF and DKIM, plus a DMARC record (required for bulk senders);
 *   - spam rate under 0.1%, never reaching 0.3% (only Google Postmaster Tools can show it);
 *   - bounce rate: keep it low — a few percent means the lists need cleaning.
 */

export type Check = { status: 'ok' | 'warn' | 'bad'; label: string; detail: string };

async function txt(name: string): Promise<string[] | null> {
  try {
    const records = await Promise.race([
      dns.resolveTxt(name),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    return records.map((parts) => parts.join(''));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOTFOUND' || code === 'ENODATA' ? [] : null; // null = couldn't check
  }
}

/** SPF, DKIM (Google Workspace selector) and DMARC for a sending domain. */
export async function domainAuthentication(domain: string): Promise<Check[]> {
  const [root, dkim, dmarc] = await Promise.all([txt(domain), txt(`google._domainkey.${domain}`), txt(`_dmarc.${domain}`)]);
  const checks: Check[] = [];

  const spf = root?.find((r) => /^v=spf1\b/i.test(r));
  if (root === null) checks.push({ status: 'warn', label: 'SPF', detail: 'Could not look up the domain right now.' });
  else if (!spf) checks.push({ status: 'bad', label: 'SPF', detail: `No SPF record on ${domain}. Add "v=spf1 include:_spf.google.com ~all" in your DNS.` });
  else if (!/include:_spf\.google\.com/i.test(spf)) checks.push({ status: 'warn', label: 'SPF', detail: `SPF exists but doesn't include Google (_spf.google.com): ${spf}` });
  else checks.push({ status: 'ok', label: 'SPF', detail: `Google is allowed to send for ${domain}.` });

  const dkimRecord = dkim?.find((r) => /v=DKIM1|k=rsa|p=/i.test(r));
  if (dkim === null) checks.push({ status: 'warn', label: 'DKIM', detail: 'Could not look up the DKIM key right now.' });
  else if (!dkimRecord) checks.push({ status: 'warn', label: 'DKIM', detail: `No Google DKIM key at google._domainkey.${domain}. Turn on "Authenticate email" in the Google Admin console (Apps → Gmail), unless your domain uses a different DKIM selector.` });
  else checks.push({ status: 'ok', label: 'DKIM', detail: 'Google signs outgoing mail for this domain.' });

  const dmarcRecord = dmarc?.find((r) => /^v=DMARC1\b/i.test(r));
  if (dmarc === null) checks.push({ status: 'warn', label: 'DMARC', detail: 'Could not look up DMARC right now.' });
  else if (!dmarcRecord) checks.push({ status: 'bad', label: 'DMARC', detail: `No DMARC record (_dmarc.${domain}). Google and Yahoo require one for bulk senders; start with "v=DMARC1; p=none; rua=mailto:dmarc@${domain}".` });
  else {
    const policy = dmarcRecord.match(/\bp=(\w+)/i)?.[1]?.toLowerCase() ?? 'none';
    checks.push({ status: 'ok', label: 'DMARC', detail: `DMARC is set (policy: ${policy}).` });
  }
  return checks;
}

function rateCheck(label: string, count: number, sent: number, warnAt: number, badAt: number, advice: string): Check & { rate: number } {
  const rate = sent > 0 ? count / sent : 0;
  const pct = `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`;
  const status = sent === 0 ? 'ok' : rate >= badAt ? 'bad' : rate >= warnAt ? 'warn' : 'ok';
  return { status, label, rate, detail: sent === 0 ? 'Nothing sent in this period.' : `${count} of ${sent} (${pct}).${status !== 'ok' ? ` ${advice}` : ''}` };
}

/** The report for a set of workspaces over the last `days` days. */
export async function deliverabilityReport(workspaceIds: string[], days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const campaignScope = { campaign: { workspaceId: { in: workspaceIds } } };

  const [sent, bounces, unsubscribes, opens, clicks, automated, recentBounces, accounts] = await Promise.all([
    prisma.emailJob.count({ where: { ...campaignScope, status: EmailJobStatus.SENT, sentAt: { gte: since } } }),
    // Bounce rate = bounces of these workspaces' own campaign emails ÷ those emails sent. Copies of a
    // teammate's bounce (org-wide suppression) and recruiter-send bounces aren't part of "sent" here.
    prisma.emailSuppression.findMany({ where: { workspaceId: { in: workspaceIds }, reason: 'BOUNCED', campaignId: { not: null }, createdAt: { gte: since } }, distinct: ['email'], select: { email: true } }).then((r) => r.length),
    prisma.emailSuppression.count({ where: { workspaceId: { in: workspaceIds }, reason: 'UNSUBSCRIBED', createdAt: { gte: since } } }),
    prisma.emailTrackingEvent.groupBy({ by: ['emailJobId'], where: { ...campaignScope, type: 'OPEN', automated: false, createdAt: { gte: since } } }).then((r) => r.length),
    prisma.emailTrackingEvent.groupBy({ by: ['emailJobId'], where: { ...campaignScope, type: 'CLICK', automated: false, createdAt: { gte: since } } }).then((r) => r.length),
    prisma.emailTrackingEvent.count({ where: { ...campaignScope, automated: true, createdAt: { gte: since } } }),
    // Each bounced address once (the org-wide copies would repeat it per workspace).
    prisma.emailSuppression.findMany({
      where: { workspaceId: { in: workspaceIds }, reason: 'BOUNCED' },
      orderBy: { createdAt: 'desc' },
      distinct: ['email'],
      take: 20,
      select: { email: true, detail: true, createdAt: true, campaign: { select: { id: true, name: true } } },
    }),
    prisma.emailProviderAccount.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { id: true, emailAddress: true, displayName: true, status: true },
      orderBy: { emailAddress: 'asc' },
    }),
  ]);

  const limit = dailyLimit();
  const mailboxes = await Promise.all(
    accounts.map(async (a) => {
      const [usage, holdUntil] = await Promise.all([usageLast24h(a.id), backoffUntil(a.id)]);
      return {
        ...a,
        sentLast24h: usage.messages,
        uniqueRecipientsLast24h: usage.unique.size,
        dailyLimit: limit,
        uniqueLimit: DAILY_UNIQUE_RECIPIENT_LIMIT,
        pausedUntil: holdUntil > 0 ? new Date(holdUntil).toISOString() : null,
      };
    }),
  );

  const domains = [...new Set(accounts.map((a) => a.emailAddress.split('@')[1]?.toLowerCase()).filter((d): d is string => !!d))].slice(0, 5);
  const authentication = await Promise.all(domains.map(async (domain) => ({ domain, checks: await domainAuthentication(domain) })));

  return {
    days,
    sent,
    rates: {
      bounce: rateCheck('Bounce rate', bounces, sent, 0.02, 0.05, 'Clean the list: remove or fix addresses before sending again.'),
      unsubscribe: rateCheck('Unsubscribe rate', unsubscribes, sent, 0.005, 0.02, 'Check who is on the list and how often they are emailed.'),
    },
    engagement: { opened: opens, clicked: clicks, automatedHitsFiltered: automated },
    mailboxes,
    authentication,
    recentBounces,
  };
}
