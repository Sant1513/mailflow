/**
 * Copies every MailFlow table from one Postgres database to another, replacing the target's
 * data. The source is read as one consistent snapshot; the target is written in one
 * transaction and every row count is checked before it commits — all or nothing.
 *
 * Never copied: the migration history (_prisma_migrations, each database keeps its own) and
 * the server switch (SystemState, which lives only in the cloud database and must never be
 * overwritten by a copy).
 *
 *   node copy-db.mjs <fromUrl> <toUrl>          (also used by start.mjs for handovers)
 */
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';

export const NEVER_COPIED = ['_prisma_migrations', 'SystemState'];

const q = (t) => `"${t.replace(/"/g, '""')}"`;
const ssl = (url) => (/127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false });
const tablesOf = async (c) =>
  (await c.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).rows
    .map((r) => r.table_name)
    .filter((t) => !NEVER_COPIED.includes(t));
const colsOf = async (c, t) =>
  (await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [t])).rows.map((r) => r.column_name);

/** Returns { tables, rows }. Throws (target unchanged) on any problem. */
export async function copyDatabase(fromUrl, toUrl) {
  const src = new pg.Client({ connectionString: fromUrl, ssl: ssl(fromUrl) });
  const dst = new pg.Client({ connectionString: toUrl, ssl: ssl(toUrl) });
  await src.connect();
  await dst.connect();
  try {
    await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await tablesOf(src);
    const targetTables = await tablesOf(dst);
    const missing = tables.filter((t) => !targetTables.includes(t));
    if (missing.length) throw new Error(`tables missing in target: ${missing.join(', ')}`);

    await dst.query('BEGIN');
    await dst.query('SET LOCAL session_replication_role = replica'); // load tables in any order
    await dst.query(`TRUNCATE ${targetTables.map(q).join(', ')}`);
    const expected = {};
    for (const t of tables) {
      // Only the columns both sides have, so a copy works across a pending migration.
      const dstCols = new Set(await colsOf(dst, t));
      const cols = (await colsOf(src, t)).filter((c) => dstCols.has(c)).map(q).join(', ');
      expected[t] = (await src.query(`select count(*)::int n from ${q(t)}`)).rows[0].n;
      if (!expected[t]) continue;
      await pipeline(
        src.query(copyStreams.to(`COPY ${q(t)} (${cols}) TO STDOUT WITH (FORMAT binary)`)),
        dst.query(copyStreams.from(`COPY ${q(t)} (${cols}) FROM STDIN WITH (FORMAT binary)`)),
      );
    }
    const mismatches = [];
    for (const t of tables) {
      const n = (await dst.query(`select count(*)::int n from ${q(t)}`)).rows[0].n;
      if (n !== expected[t]) mismatches.push(`${t}: expected ${expected[t]}, got ${n}`);
    }
    if (mismatches.length) throw new Error(`row counts differ: ${mismatches.join('; ')}`);
    await dst.query('COMMIT');
    await src.query('COMMIT');
    return { tables: tables.length, rows: Object.values(expected).reduce((a, b) => a + b, 0) };
  } catch (err) {
    await dst.query('ROLLBACK').catch(() => {});
    await src.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [fromUrl, toUrl] = process.argv.slice(2);
  if (!fromUrl || !toUrl) {
    console.error('Usage: node copy-db.mjs <fromUrl> <toUrl>');
    process.exit(1);
  }
  copyDatabase(fromUrl, toUrl)
    .then((r) => console.log(`Copied ${r.tables} tables (${r.rows} rows); every row count matches.`))
    .catch((err) => {
      console.error('Copy failed, target unchanged:', err.message);
      process.exitCode = 1;
    });
}
