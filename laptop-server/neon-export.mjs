// One-time: copies every table of the old Neon MailFlow database to gzipped CSV files.
// Usage: node neon-export.mjs <envFileWithNEON_OLD_DIRECT_URL> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';

const [envFile, outDir] = process.argv.slice(2);
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^"|"$/g, '')]));
const url = env.NEON_OLD_DIRECT_URL || env.NEON_OLD_DATABASE_URL;
fs.mkdirSync(outDir, { recursive: true });
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 30000 });
await client.connect();
await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // one consistent snapshot
const { rows } = await client.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`);
const counts = {};
for (const { table_name: t } of rows) {
  counts[t] = (await client.query(`select count(*)::int n from "${t}"`)).rows[0].n;
  await pipeline(client.query(copyStreams.to(`COPY "${t}" TO STDOUT WITH (FORMAT csv, HEADER)`)), createGzip(), fs.createWriteStream(path.join(outDir, `${t}.csv.gz`)));
}
await client.query('COMMIT');
await client.end();
fs.writeFileSync(path.join(outDir, 'tables.json'), JSON.stringify(counts, null, 2));
console.log('exported', rows.length, 'tables to', outDir);
