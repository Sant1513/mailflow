/**
 * Copies every MailFlow table from one Postgres database to another, replacing the target's
 * data. The source is read as one consistent snapshot; the target is written in one
 * transaction and every row count is checked before it commits — all or nothing.
 * The target keeps its own migration history (_prisma_migrations).
 *
 *   node copy-db.mjs <fromUrl> <toUrl>
 *
 * Used to move the laptop database to Supabase (2026-11-02). The target's tables must
 * already exist with the same columns (prisma db push / migrate).
 */
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';

const [fromUrl, toUrl] = process.argv.slice(2);
if (!fromUrl || !toUrl) {
  console.error('Usage: node copy-db.mjs <fromUrl> <toUrl>');
  process.exit(1);
}
const q = (t) => `"${t.replace(/"/g, '""')}"`;
const ssl = (url) => (/127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false });
const src = new pg.Client({ connectionString: fromUrl, ssl: ssl(fromUrl) });
const dst = new pg.Client({ connectionString: toUrl, ssl: ssl(toUrl) });
await src.connect();
await dst.connect();

const tablesOf = async (c) =>
  (await c.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name <> '_prisma_migrations' order by 1`)).rows.map((r) => r.table_name);
const colsOf = async (c, t) =>
  (await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [t])).rows.map((r) => r.column_name);

try {
  await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables = await tablesOf(src);
  const targetTables = new Set(await tablesOf(dst));
  const missing = tables.filter((t) => !targetTables.has(t));
  if (missing.length) throw new Error(`tables missing in target: ${missing.join(', ')}`);

  await dst.query('BEGIN');
  await dst.query('SET LOCAL session_replication_role = replica'); // load tables in any order
  await dst.query(`TRUNCATE ${[...targetTables].map(q).join(', ')} CASCADE`);
  const expected = {};
  for (const t of tables) {
    const cols = (await colsOf(src, t)).map(q).join(', ');
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
  if (mismatches.length) throw new Error(`row counts differ:\n  ${mismatches.join('\n  ')}`);
  await dst.query('COMMIT');
  await src.query('COMMIT');
  const total = Object.values(expected).reduce((a, b) => a + b, 0);
  console.log(`Copied ${tables.length} tables (${total} rows); every row count matches.`);
} catch (err) {
  await dst.query('ROLLBACK').catch(() => {});
  await src.query('ROLLBACK').catch(() => {});
  console.error('Copy failed, target unchanged:', err.message);
  process.exitCode = 1;
} finally {
  await src.end();
  await dst.end();
}
