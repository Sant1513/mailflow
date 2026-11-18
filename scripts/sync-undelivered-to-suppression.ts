/**
 * One-off (safe to re-run): puts every address that is known NOT to deliver on the suppression
 * list, from the records the senders keep. Adds rows only; nothing is removed or changed, and an
 * address that is already suppressed (unsubscribed, bounced, manual…) is left exactly as it is.
 *
 * Sources (address-level, permanent failures only):
 *   1. Quick Send / campaign emails Gmail rejected outright (EmailJob FAILED, INVALID_RECIPIENT)
 *   2. Quick Send / campaign emails that bounced afterwards (EmailJob errorCode BOUNCED)
 *   3. Recruiter Bulk Send recruiters marked bounced
 *   4. Recruiter Bulk Send individual copies Gmail rejected (group INVALID_RECIPIENT)
 *
 * NOT suppressed (not the recipient's fault, so blocking them would be wrong): our mailbox's
 * quota / rate limit / sign-in problems, timeouts and network errors, document-generation errors,
 * "sending was interrupted", cancelled sends, and a first "mailbox full" notice (the app's own
 * rule waits for a second one). They are counted at the end so nothing is hidden.
 *
 * Without --apply it only reads and reports. With --apply it writes through recordHardBounce
 * (lib/email/bounces.ts): every workspace of the organization, same reason texts as live bounces.
 *
 *   npx tsx scripts/sync-undelivered-to-suppression.ts            # report only
 *   npx tsx scripts/sync-undelivered-to-suppression.ts --apply    # write
 */
import 'dotenv/config';
import { prisma } from '../lib/db/client';
import { recordHardBounce } from '../lib/email/bounces';

const apply = process.argv.includes('--apply');

interface Candidate {
  workspaceId: string;
  email: string;
  source: string;
  detail: string;
  campaignId?: string | null;
  recruiterBlastId?: string | null;
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

async function gather(): Promise<Candidate[]> {
  const out: Candidate[] = [];

  const jobs = await prisma.emailJob.findMany({
    where: { OR: [{ errorCode: 'BOUNCED' }, { status: 'FAILED', errorCode: 'INVALID_RECIPIENT' }] },
    select: { toEmail: true, errorCode: true, errorMessage: true, campaignId: true, campaign: { select: { workspaceId: true } } },
  });
  for (const j of jobs) {
    if (!j.toEmail || !j.campaign?.workspaceId) continue;
    out.push({
      workspaceId: j.campaign.workspaceId,
      email: j.toEmail,
      source: j.errorCode === 'BOUNCED' ? 'email bounced' : 'email rejected by Gmail',
      detail: j.errorCode === 'BOUNCED' ? `Bounced (synced from the send record): ${clean(j.errorMessage)}` : `Gmail rejected the address when sending (INVALID_RECIPIENT): ${clean(j.errorMessage)}`,
      campaignId: j.campaignId,
    });
  }

  const recruiters = await prisma.recruiterBlastRecipient.findMany({
    where: { status: 'BOUNCED' },
    select: { email: true, skipReason: true, blastId: true, blast: { select: { workspaceId: true } } },
  });
  for (const r of recruiters) {
    out.push({ workspaceId: r.blast.workspaceId, email: r.email, source: 'recruiter bounced', detail: `Bounced (synced from a Recruiter Bulk Send): ${clean(r.skipReason)}`, recruiterBlastId: r.blastId });
  }

  const rejectedGroups = await prisma.recruiterBlastGroup.findMany({
    where: { status: 'FAILED', errorCode: 'INVALID_RECIPIENT', blast: { mode: 'INDIVIDUAL' } },
    select: { id: true, error: true, blastId: true, blast: { select: { workspaceId: true } } },
  });
  if (rejectedGroups.length) {
    const byGroup = new Map(rejectedGroups.map((g) => [g.id, g]));
    const people = await prisma.recruiterBlastRecipient.findMany({ where: { groupId: { in: [...byGroup.keys()] } }, select: { email: true, groupId: true } });
    for (const p of people) {
      const g = byGroup.get(p.groupId!)!;
      out.push({ workspaceId: g.blast.workspaceId, email: p.email, source: 'recruiter email rejected by Gmail', detail: `Gmail rejected the address when sending (INVALID_RECIPIENT): ${clean(g.error)}`, recruiterBlastId: g.blastId });
    }
  }
  return out;
}

async function main() {
  const host = (() => { try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '?'; } })();
  console.log(`${apply ? 'APPLY' : 'REPORT ONLY'} against ${host}\n`);

  const all = await gather();
  // One entry per workspace + address (the first source found keeps the story).
  const unique = new Map<string, Candidate>();
  for (const c of all) {
    const key = `${c.workspaceId}|${c.email.trim().toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, { ...c, email: c.email.trim().toLowerCase() });
  }
  const list = [...unique.values()].filter((c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email));
  console.log(`Found ${all.length} failed / bounced record(s) → ${list.length} distinct address(es).`);

  // Already suppressed in that workspace (any reason): left alone.
  const have = new Set<string>();
  for (let i = 0; i < list.length; i += 1000) {
    const chunk = list.slice(i, i + 1000);
    const rows = await prisma.emailSuppression.findMany({
      where: { OR: [...new Set(chunk.map((c) => c.workspaceId))].map((w) => ({ workspaceId: w, email: { in: chunk.filter((c) => c.workspaceId === w).map((c) => c.email) } })) },
      select: { workspaceId: true, email: true },
    });
    for (const r of rows) have.add(`${r.workspaceId}|${r.email.toLowerCase()}`);
  }
  const missing = list.filter((c) => !have.has(`${c.workspaceId}|${c.email}`));
  console.log(`Already on the suppression list: ${list.length - missing.length}. To add: ${missing.length}.\n`);

  const bySource = new Map<string, number>();
  for (const c of missing) bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
  for (const [s, n] of bySource) console.log(`  ${String(n).padStart(5)}  ${s}`);
  if (missing.length) console.log('\nExamples:');
  for (const c of missing.slice(0, 8)) console.log(`  ${c.email}  (${c.source}) ${c.detail.slice(0, 110)}`);

  if (apply && missing.length) {
    let done = 0;
    let failed = 0;
    for (const c of missing) {
      try {
        await recordHardBounce({ workspaceId: c.workspaceId, email: c.email, detail: c.detail, campaignId: c.campaignId ?? null, recruiterBlastId: c.recruiterBlastId ?? null, webhook: false, remark: `Synced from ${c.source}` });
        done++;
      } catch (err) {
        failed++;
        console.error(`  could not add ${c.email}:`, (err as Error).message);
      }
    }
    console.log(`\nAdded ${done} address(es)${failed ? `, ${failed} failed` : ''}.`);
  }

  // Everything else that failed, counted so nothing is hidden (not suppressed: not the recipient's fault).
  console.log('\nOther failures, NOT suppressed (not the recipient’s fault):');
  const jobErrors = await prisma.emailJob.groupBy({ by: ['errorCode'], where: { status: 'FAILED', NOT: { errorCode: 'INVALID_RECIPIENT' } }, _count: { _all: true } });
  for (const e of jobErrors) console.log(`  ${String(e._count._all).padStart(5)}  emails: ${e.errorCode ?? '(no code)'}`);
  const groupErrors = await prisma.recruiterBlastGroup.groupBy({ by: ['errorCode'], where: { status: 'FAILED', NOT: { errorCode: 'INVALID_RECIPIENT' } }, _count: { _all: true } });
  for (const e of groupErrors) console.log(`  ${String(e._count._all).padStart(5)}  recruiter emails: ${e.errorCode ?? '(no code)'}`);
  const bccRejected = await prisma.recruiterBlastGroup.count({ where: { status: 'FAILED', errorCode: 'INVALID_RECIPIENT', blast: { mode: 'BCC' } } });
  if (bccRejected) console.log(`  ${String(bccRejected).padStart(5)}  BCC groups Gmail rejected (it does not say which address, so none can be suppressed)`);
  if (!jobErrors.length && !groupErrors.length && !bccRejected) console.log('  none');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
