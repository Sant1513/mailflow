/**
 * Backfill bounce / delivery notices that sync missed (before lib/email/dsn.ts + lib/email/ndr.ts).
 * For every CONNECTED mailbox it searches Gmail (read-only) for notices from the last N days,
 * reads each with the live parser, matches it to our sends, and prints what it would do.
 * Nothing is written unless --apply is given; re-running is safe (suppressions are upserts,
 * soft-bounce notes are keyed by Gmail message id).
 *
 *   # dry run (default): prints address · category · code · remark · send · would-suppress
 *   DATABASE_URL=<database> npx tsx scripts/backfill-ndr.ts [--days=30] [--mailbox=a@x.com] [--max=500]
 *   # write it
 *   DATABASE_URL=<database> npx tsx scripts/backfill-ndr.ts --apply
 *
 * Note: reading a mailbox may refresh its Gmail access token, which the app's Gmail client saves
 * on the account (lib/gmail/oauth.ts) — the same as any sync.
 */
import 'dotenv/config';
import { prisma } from '../lib/db/client';
import { gmailSourceFor } from '../lib/gmail/sync';
import { searchMessageIds } from '../lib/gmail/search';
import { ndrSearchQuery, processNotice } from '../lib/email/ndrBackfill';
import { describeAction, willSuppress } from '../lib/email/ndr';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const days = Number(arg('days') ?? 30) || 30;
const max = Number(arg('max') ?? 500) || 500;
const onlyMailbox = arg('mailbox')?.toLowerCase();

async function main() {
  const accounts = await prisma.emailProviderAccount.findMany({
    where: { status: 'CONNECTED', ...(onlyMailbox ? { emailAddress: { equals: onlyMailbox, mode: 'insensitive' } } : {}) },
    orderBy: { emailAddress: 'asc' },
  });
  const q = ndrSearchQuery(days);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} · ${accounts.length} connected mailbox(es) · Gmail query: ${q}\n`);
  const totals = { notices: 0, notReports: 0, actions: 0, suppress: 0, soft: 0, noMatch: 0, errors: 0 };

  for (const account of accounts) {
    let ids: { id: string }[] = [];
    try {
      ids = await searchMessageIds(account, q, max);
    } catch (err) {
      totals.errors += 1;
      console.log(`■ ${account.emailAddress}: search failed — ${(err as Error).message}\n`);
      continue;
    }
    console.log(`■ ${account.emailAddress}: ${ids.length} notice(s)`);
    const source = gmailSourceFor(account);
    for (const { id } of ids) {
      totals.notices += 1;
      try {
        const raw = await source.getMessage(id);
        if (!raw) continue;
        const r = await processNotice(account, raw, { apply });
        const when = r.receivedAt.toISOString().slice(0, 16).replace('T', ' ');
        if (r.skipped) {
          totals.notReports += 1;
          console.log(`  · ${when} “${r.subject.slice(0, 70)}” — skipped: ${r.skipped}`);
          continue;
        }
        console.log(`  · ${when} “${r.subject.slice(0, 70)}” from ${r.from}`);
        for (const a of r.actions) {
          totals.actions += 1;
          if (willSuppress(a.decision)) totals.suppress += 1;
          else if (a.decision === 'NO_MATCH') totals.noMatch += 1;
          else totals.soft += 1;
          console.log(`      ${willSuppress(a.decision) ? (apply ? 'SUPPRESSED' : 'WOULD SUPPRESS') : a.decision === 'NO_MATCH' ? 'not ours  ' : 'no suppress'} ${describeAction(a)}`);
        }
      } catch (err) {
        totals.errors += 1;
        console.log(`  ! ${id}: ${(err as Error).message}`);
      }
    }
    console.log('');
  }

  console.log(
    `Done. ${totals.notices} notice(s) read, ${totals.notReports} not delivery reports, ${totals.actions} address(es): ` +
      `${totals.suppress} ${apply ? 'suppressed' : 'would be suppressed'}, ${totals.soft} noted only, ${totals.noMatch} not about MailFlow sends, ${totals.errors} error(s).` +
      (apply ? '' : '\nNothing was written. Run again with --apply to write.'),
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
