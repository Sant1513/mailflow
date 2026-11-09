import { prisma } from '@/lib/db/client';
import { dispatchWebhook } from '@/lib/webhooks/dispatch';
import { readListUnsubscribeToken, unsubscribeMailtoFor } from '@/lib/recruiterSend/core';

/**
 * Unsubscribe by email: works for EVERY email, including BCC sends.
 *
 * A BCC email is the same message for everyone, so a link can't tell who clicked it. A mailto
 * link can: Gmail's own "Unsubscribe" button (List-Unsubscribe header) and our button in the
 * email both send a short email FROM the recipient TO the sending mailbox, with a subject like
 * "Unsubscribe rb-<code>". MailFlow already reads that mailbox (lib/gmail/ingest.ts), so it knows
 * exactly who asked, suppresses that address and drops them from the rest of the send.
 *
 * Codes: rb-<signed recruiter-send token> · cj-<campaign email's unsubscribe token>.
 * A plain "Unsubscribe" subject with no code also counts (someone typing it themselves).
 */

export type UnsubscribeCode = { kind: 'rb'; token: string } | { kind: 'cj'; token: string } | { kind: 'plain' };

const SUBJECT = /^\s*(?:(?:re|fwd?|aw)\s*:\s*)*unsubscribe(?:\s+me)?(?:\s+(rb|cj)-([A-Za-z0-9_.\-]{8,200}))?\s*[.!]?\s*$/i;

/** The mailto: for List-Unsubscribe and the button: an email to the sending mailbox. */
export const unsubscribeMailto = unsubscribeMailtoFor;

/** Is this incoming email an unsubscribe request (by its subject)? */
export function parseUnsubscribeSubject(subject: string | null | undefined): UnsubscribeCode | null {
  const m = (subject ?? '').match(SUBJECT);
  if (!m) return null;
  if (m[1] && m[2]) return { kind: m[1].toLowerCase() as 'rb' | 'cj', token: m[2] };
  return { kind: 'plain' };
}

/**
 * Suppresses whoever sent an unsubscribe email (and, for a campaign email, the address it was
 * sent to, in case they replied from another address). An existing bounce/complaint keeps its
 * reason. Returns the addresses suppressed, or null when the request couldn't be placed.
 */
export async function handleUnsubscribeEmail(
  account: { workspaceId: string; emailAddress: string },
  fromEmail: string,
  code: UnsubscribeCode,
): Promise<{ workspaceId: string; emails: string[]; label: string } | null> {
  const from = fromEmail.trim().toLowerCase();
  if (!from || from === account.emailAddress.toLowerCase()) return null;
  let workspaceId = account.workspaceId;
  const emails = new Set([from]);
  let label = 'Asked to unsubscribe by email';
  let campaignId: string | null = null;

  if (code.kind === 'rb') {
    const blastId = readListUnsubscribeToken(code.token);
    const blast = blastId ? await prisma.recruiterBlast.findUnique({ where: { id: blastId }, select: { id: true, workspaceId: true, name: true } }) : null;
    if (blast) {
      workspaceId = blast.workspaceId;
      label = `Unsubscribed by email from Recruiter Bulk Send “${blast.name}”`;
      // Not in this send's later messages either.
      await prisma.recruiterBlastRecipient.updateMany({ where: { blastId: blast.id, email: from, status: { in: ['PENDING', 'QUEUED'] }, OR: [{ groupId: null }, { group: { status: 'PENDING' } }] }, data: { status: 'SKIPPED', skipReason: 'Unsubscribed' } });
    }
  } else if (code.kind === 'cj') {
    const job = await prisma.emailJob.findFirst({ where: { unsubscribeToken: code.token }, select: { toEmail: true, campaignId: true, campaign: { select: { workspaceId: true, name: true } } } });
    if (job) {
      workspaceId = job.campaign.workspaceId;
      campaignId = job.campaignId;
      emails.add(job.toEmail.toLowerCase());
      label = `Unsubscribed by email from “${job.campaign.name}”`;
    }
  }

  for (const email of emails) {
    await prisma.emailSuppression.upsert({
      where: { workspaceId_email: { workspaceId, email } },
      create: { workspaceId, email, reason: 'UNSUBSCRIBED', source: 'UNSUBSCRIBE', detail: label, ...(campaignId ? { campaignId } : {}) },
      update: {},
    });
    dispatchWebhook(workspaceId, 'email.unsubscribed', { email }).catch(() => undefined);
  }
  return { workspaceId, emails: [...emails], label };
}
