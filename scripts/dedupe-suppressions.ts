/**
 * Removes the copies of bounces and spam complaints that were saved in every workspace of an organisation
 * (see lib/suppressions/scope.ts: it is one shared list now). One entry per address and organisation is kept,
 * preferring the original (the one tied to a send, not a "known across the organisation" copy), then the oldest.
 * Unsubscribes and manual entries are never touched. Nothing is removed unless another entry for the same
 * address stays in the same organisation, so no address stops being blocked.
 *
 *   npx tsx scripts/dedupe-suppressions.ts            report only
 *   npx tsx scripts/dedupe-suppressions.ts --apply    delete the copies (in batches), then reclaim the space
 */
import { prisma } from '../lib/db/client';

const apply = process.argv.includes('--apply');
const BATCH = 20_000;

const RANKED = `
  SELECT s.id, row_number() OVER (
    PARTITION BY w."organizationId", lower(s.email)
    ORDER BY (s.detail LIKE '%teammate''s send)' OR s.detail LIKE '%known across the organisation)') ASC,
             (s."campaignId" IS NULL AND s."recruiterBlastId" IS NULL) ASC,
             s."createdAt" ASC, s.id ASC) AS rn
  FROM "EmailSuppression" s JOIN "Workspace" w ON w.id = s."workspaceId"
  WHERE s.reason IN ('BOUNCED', 'COMPLAINT')`;

const n = (x: unknown) => Number(x);

async function main() {
  const total = n((await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*) c FROM "EmailSuppression"`))[0]!.c);
  const copies = n((await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*) c FROM (${RANKED}) r WHERE rn > 1`))[0]!.c);
  const unique = n((await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*) c FROM (${RANKED}) r WHERE rn = 1`))[0]!.c);
  console.log(`rows ${total} · shared entries to keep ${unique} · copies to remove ${copies}`);
  if (!apply) { console.log('Report only. Run with --apply to delete the copies.'); await prisma.$disconnect(); return; }

  let removed = 0;
  for (;;) {
    const r = await prisma.$executeRawUnsafe(`DELETE FROM "EmailSuppression" WHERE id IN (SELECT id FROM (${RANKED}) r WHERE rn > 1 LIMIT ${BATCH})`);
    removed += r;
    console.log(`removed ${removed} / ${copies}`);
    if (r === 0) break;
  }
  const left = n((await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*) c FROM (${RANKED}) r WHERE rn > 1`))[0]!.c);
  console.log(`copies left: ${left}`);
  if (left === 0) {
    console.log('Reclaiming the space (VACUUM FULL)…');
    await prisma.$executeRawUnsafe(`VACUUM FULL "EmailSuppression"`);
  }
  const size = (await prisma.$queryRawUnsafe<{ s: string }[]>(`SELECT pg_size_pretty(pg_database_size(current_database())) s`))[0]!.s;
  console.log(`database size now ${size}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
