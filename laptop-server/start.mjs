/**
 * MailFlow laptop server: database + app + background jobs, kept running on this laptop.
 *
 *   node start.mjs            start everything (Windows runs this at sign-in, see install.mjs)
 *
 * What it does, in order:
 *   1. Starts Postgres from ../laptop-server/node_modules (no installer), data in MAILFLOW_DATA\pg.
 *      Listens on 127.0.0.1 only: the database is never reachable from outside the laptop.
 *   2. Applies any new database migrations.
 *   3. Builds the app if needed and runs it on 127.0.0.1:3100 (Tailscale Funnel publishes it,
 *      Vercel forwards the public address to it: middleware.ts).
 *   4. Runs the background jobs on the same schedule Vercel/GitHub did. Anything that came due
 *      while the laptop was off runs as soon as it is back, so sending carries on where it
 *      stopped (emails already sent are never sent again: each job is claimed before sending
 *      and half-finished ones are checked against Gmail's Sent folder first).
 *   5. Backs the database up every night (7 days kept) in MAILFLOW_DATA\backups.
 * If the app or the database stops unexpectedly, it is restarted.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const DATA = process.env.MAILFLOW_DATA || path.join(os.homedir(), 'mailflow-data');
const PG_DIR = path.join(DATA, 'pg');
const LOG_DIR = path.join(DATA, 'logs');
const BACKUP_DIR = path.join(DATA, 'backups');
const STATE_FILE = path.join(DATA, 'state.json');
const LOCK_FILE = path.join(DATA, 'server.lock');
const PG_PORT = 5433;
const APP_PORT = 3100;
const APP_LOCAL = `http://127.0.0.1:${APP_PORT}`;

for (const dir of [DATA, LOG_DIR, BACKUP_DIR]) fs.mkdirSync(dir, { recursive: true });

// ---------- logging ----------
const LOG_FILE = path.join(LOG_DIR, 'server.log');
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 10 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// ---------- single instance ----------
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
if (fs.existsSync(LOCK_FILE)) {
  const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
  if (pid && pid !== process.pid && isAlive(pid)) {
    log(`Already running (pid ${pid}); exiting.`);
    process.exit(0);
  }
}
fs.writeFileSync(LOCK_FILE, String(process.pid));

// ---------- settings ----------
function readEnvFile(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

const DB_FILE = path.join(DATA, 'db.json');
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ user: 'mailflow', password: randomBytes(24).toString('hex'), database: 'mailflow' }, null, 2));
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const DATABASE_URL = `postgresql://${db.user}:${db.password}@127.0.0.1:${PG_PORT}/${db.database}?connection_limit=10`;

const appEnvFile = path.join(DATA, 'app.env');
if (!fs.existsSync(appEnvFile)) {
  log(`Missing ${appEnvFile}. Copy the app settings there first (see README.md).`);
  process.exit(1);
}
const APP_ENV = {
  ...process.env,
  ...readEnvFile(appEnvFile),
  DATABASE_URL,
  DIRECT_URL: DATABASE_URL,
  INTERNAL_APP_URL: APP_LOCAL,
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
};
delete APP_ENV.REDIS_URL; // no Redis here: the database-backed send worker is used
delete APP_ENV.LAPTOP_UPSTREAM; // this IS the upstream

// ---------- helpers ----------
const node = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runStep(label, args) {
  log(`${label}…`);
  const r = spawnSync(node, args, { cwd: APP_DIR, env: APP_ENV, stdio: 'pipe', encoding: 'utf8', windowsHide: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) {
    log(`${label} failed (exit ${r.status}):\n${out.slice(-4000)}`);
    return false;
  }
  log(`${label} done.`);
  return true;
}

// ---------- database ----------
let pgServer;
async function startDatabase() {
  pgServer = new EmbeddedPostgres({
    databaseDir: PG_DIR,
    port: PG_PORT,
    user: db.user,
    password: db.password,
    authMethod: 'scram-sha-256',
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog: () => {},
    onError: (e) => log('[postgres]', String(e).trim()),
  });
  if (!fs.existsSync(path.join(PG_DIR, 'PG_VERSION'))) {
    log('Creating the database for the first time…');
    await pgServer.initialise();
  }
  try {
    await pgServer.start();
  } catch (err) {
    // A database left running by an earlier copy of this script (e.g. after a crash): stop it and retry.
    log('Database did not start, stopping any leftover copy and retrying:', String(err?.message ?? err));
    const pgCtl = path.join(HERE, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin', 'pg_ctl.exe');
    spawnSync(pgCtl, ['stop', '-D', PG_DIR, '-m', 'fast'], { stdio: 'ignore', windowsHide: true });
    await sleep(2000);
    await pgServer.start();
  }
  const client = pgServer.getPgClient('postgres', '127.0.0.1');
  await client.connect();
  const exists = await client.query('select 1 from pg_database where datname = $1', [db.database]);
  await client.end();
  if (!exists.rowCount) await pgServer.createDatabase(db.database);
  log(`Database running on 127.0.0.1:${PG_PORT}.`);
}

// ---------- app ----------
const NEXT_BIN = path.join(APP_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
const PRISMA_BIN = path.join(APP_DIR, 'node_modules', 'prisma', 'build', 'index.js');
let app;
let stopping = false;

function startApp() {
  log(`Starting the app on ${APP_LOCAL}…`);
  const out = fs.openSync(path.join(LOG_DIR, 'app.log'), 'a');
  app = spawn(node, [NEXT_BIN, 'start', '-p', String(APP_PORT), '-H', '127.0.0.1'], { cwd: APP_DIR, env: APP_ENV, stdio: ['ignore', out, out], windowsHide: true });
  app.on('exit', (code) => {
    if (stopping) return;
    log(`App stopped (exit ${code}); restarting in 5 s.`);
    setTimeout(startApp, 5000);
  });
}

async function waitForApp() {
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${APP_LOCAL}/api/ping`).then((r) => r.ok).catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

// ---------- background jobs ----------
// Same jobs as vercel.json + .github/workflows; times are UTC.
const JOBS = [
  { name: 'send-queue', path: '/api/cron/send-queue?reason=laptop', everyMin: 1 },
  { name: 'gmail-sync', path: '/api/cron/gmail-sync', everyMin: 15 },
  { name: 'follow-ups', path: '/api/cron/follow-ups', everyMin: 15 },
  { name: 'sheets-sync', path: '/api/cron/sheets-sync', everyMin: 15 },
  { name: 'scheduled-send', path: '/api/cron/scheduled-send', dailyAt: [0, 0] },
  { name: 'scheduled-replies', path: '/api/cron/scheduled-replies', dailyAt: [0, 0] },
  { name: 'daily-digest', path: '/api/cron/daily-digest', dailyAt: [3, 30] },
  { name: 'sla-check', path: '/api/cron/sla-check', dailyAt: [8, 0] },
  { name: 'signing-reminders', path: '/api/cron/signing-reminders', dailyAt: [9, 0] },
  { name: 'weekly-report', path: '/api/cron/weekly-report', dailyAt: [3, 30], weekday: 1 },
];
// A daily job missed while the laptop was off still runs when it is back, unless it is
// more than this late (a digest arriving in the evening helps nobody).
const DAILY_CATCH_UP_MS = 12 * 3600_000;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { lastRun: {} }; }
}
function writeState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

/** The most recent time this daily/weekly job was due, at or before `now`. */
function lastDue(job, now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), job.dailyAt[0], job.dailyAt[1]));
  while (d > now || (job.weekday !== undefined && d.getUTCDay() !== job.weekday)) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function isDue(job, last, now) {
  if (job.everyMin) return !last || now - last >= job.everyMin * 60_000 - 5_000;
  const due = lastDue(job, now);
  if (last && last >= due.getTime()) return false;
  return now - due.getTime() <= DAILY_CATCH_UP_MS;
}

const running = new Set();
async function runJob(job) {
  running.add(job.name);
  const started = Date.now();
  try {
    const res = await fetch(`${APP_LOCAL}${job.path}`, {
      headers: { Authorization: `Bearer ${APP_ENV.CRON_SECRET}` },
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const body = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
    if (!res.ok || job.name !== 'send-queue' || /"sent":[1-9]/.test(body)) log(`[job] ${job.name} ${res.status} in ${Date.now() - started} ms ${body}`);
  } catch (err) {
    log(`[job] ${job.name} failed:`, String(err?.message ?? err));
  } finally {
    running.delete(job.name);
  }
}

function tickJobs() {
  const state = readState();
  const now = Date.now();
  for (const job of JOBS) {
    if (running.has(job.name)) continue;
    if (!isDue(job, state.lastRun[job.name], now)) continue;
    state.lastRun[job.name] = now;
    runJob(job);
  }
  writeState(state);
}

// ---------- nightly backup ----------
// Every table as gzipped CSV (restore.mjs reads these back). Runs at 21:30 UTC (03:00 IST),
// or as soon as the laptop is on if the last one is more than a day old.
async function backup() {
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = path.join(BACKUP_DIR, stamp);
  const tmp = `${dir}.partial`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const client = new pg.Client({ connectionString: DATABASE_URL.replace(/\?.*$/, '') });
  await client.connect();
  try {
    const { rows } = await client.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`);
    for (const { table_name: t } of rows) {
      const stream = client.query(copyStreams.to(`COPY "${t}" TO STDOUT WITH (FORMAT csv, HEADER)`));
      await pipeline(stream, createGzip(), fs.createWriteStream(path.join(tmp, `${t}.csv.gz`)));
    }
    fs.writeFileSync(path.join(tmp, 'tables.json'), JSON.stringify(rows.map((r) => r.table_name)));
  } finally {
    await client.end();
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  const all = fs.readdirSync(BACKUP_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
  for (const old of all.slice(0, -7)) fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
  const state = readState();
  state.lastBackup = Date.now();
  writeState(state);
  log(`Backup written to ${dir}.`);
}

let backingUp = false;
function tickBackup() {
  if (backingUp) return;
  const state = readState();
  const now = new Date();
  const dueToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 30));
  const lastDueAt = dueToday <= now ? dueToday : new Date(dueToday.getTime() - 86_400_000);
  if (state.lastBackup && state.lastBackup >= lastDueAt.getTime()) return;
  backingUp = true;
  backup().catch((e) => log('Backup failed:', e)).finally(() => { backingUp = false; });
}

// ---------- shutdown ----------
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`Stopping (${signal})…`);
  try { app?.kill(); } catch {}
  await sleep(1500);
  try { await pgServer?.stop(); } catch (e) { log('Database stop:', String(e)); }
  try { fs.rmSync(LOCK_FILE, { force: true }); } catch {}
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => shutdown(sig));
process.on('uncaughtException', (e) => log('Unexpected error:', e));
process.on('unhandledRejection', (e) => log('Unexpected error:', e));

// ---------- go ----------
log(`MailFlow laptop server starting (app ${APP_DIR}, data ${DATA}).`);
await startDatabase();
if (!runStep('Applying database migrations', [PRISMA_BIN, 'migrate', 'deploy'])) process.exit(1);
if (!fs.existsSync(path.join(APP_DIR, '.next', 'BUILD_ID'))) {
  if (!runStep('Building the app (first run, takes a few minutes)', [NEXT_BIN, 'build'])) process.exit(1);
}
startApp();
if (!(await waitForApp())) log('App did not answer within 2 minutes; jobs will start once it does.');
log('Ready.');
tickJobs();
setInterval(tickJobs, 20_000);
tickBackup();
setInterval(tickBackup, 10 * 60_000);
