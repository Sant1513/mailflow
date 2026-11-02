/**
 * One-time: loads a Neon export (from neon-export.mjs) into the laptop database, replacing
 * what is there. Everything happens in one transaction: either all of Neon's data is in and
 * every row count matches, or nothing changes.
 *
 *   node neon-import.mjs <exportDir>
 *
 * Before touching anything, the current laptop data is backed up to
 * MAILFLOW_DATA\backups\pre-neon-import-<time>\ (same format as the nightly backups).
 * The migration history (_prisma_migrations) is kept as it is on the laptop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';

const exportDir = process.argv[2];
if (!exportDir || !fs.existsSync(path.join(exportDir, 'tables.json'))) {
  console.error('Usage: node neon-import.mjs <exportDir containing tables.json>');
  process.exit(1);
}
const DATA = process.env.MAILFLOW_DATA || path.join(os.homedir(), 'mailflow-data');
const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
const client = new pg.Client({ connectionString: `postgresql://${db.user}:${db.password}@127.0.0.1:5433/${db.database}` });
await client.connect();

const q = (t) => `"${t.replace(/"/g, '""')}"`;
const expected = JSON.parse(fs.readFileSync(path.join(exportDir, 'tables.json'), 'utf8'));
const tables = Object.keys(expected).filter((t) => t !== '_prisma_migrations');
const localTables = (await client.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name <> '_prisma_migrations' order by 1`)).rows.map((r) => r.table_name);

// 1. Back up what's there now.
const backupDir = path.join(DATA, 'backups', `pre-neon-import-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(backupDir, { recursive: true });
for (const t of localTables) {
  await pipeline(client.query(copyStreams.to(`COPY ${q(t)} TO STDOUT WITH (FORMAT csv, HEADER)`)), createGzip(), fs.createWriteStream(path.join(backupDir, `${t}.csv.gz`)));
}
console.log(`Backed up the current laptop data to ${backupDir}`);

// 2. Replace, all or nothing.
try {
  await client.query('BEGIN');
  await client.query('SET LOCAL session_replication_role = replica'); // load tables in any order
  await client.query(`TRUNCATE ${localTables.map(q).join(', ')} CASCADE`);
  for (const t of tables) {
    const file = path.join(exportDir, `${t}.csv.gz`);
    const header = await new Promise((resolve, reject) => {
      const s = fs.createReadStream(file).pipe(createGunzip());
      let buf = '';
      s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { s.destroy(); resolve(buf.slice(0, i)); } });
      s.on('end', () => resolve(buf));
      s.on('error', reject);
    });
    const cols = header.replace(/\r$/, '').split(',').map((c) => c.replace(/^"|"$/g, ''));
    await pipeline(fs.createReadStream(file), createGunzip(), client.query(copyStreams.from(`COPY ${q(t)} (${cols.map(q).join(', ')}) FROM STDIN WITH (FORMAT csv, HEADER)`)));
  }
  const mismatches = [];
  for (const t of tables) {
    const n = (await client.query(`select count(*)::int n from ${q(t)}`)).rows[0].n;
    if (n !== expected[t]) mismatches.push(`${t}: expected ${expected[t]}, got ${n}`);
  }
  if (mismatches.length) throw new Error(`row counts differ:\n  ${mismatches.join('\n  ')}`);
  await client.query('COMMIT');
  console.log(`Imported ${tables.length} tables; every row count matches the Neon export.`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Import failed, nothing was changed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
