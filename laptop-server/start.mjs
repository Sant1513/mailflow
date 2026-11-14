/**
 * MailFlow laptop server: the laptop side of the server switch (lib/system/serverState.ts).
 *
 *   node start.mjs            start (Windows runs this at sign-in, see install.mjs)
 *
 * MailFlow runs on one server at a time: the cloud (Vercel + Supabase, normally) or this
 * laptop. The switch lives in the cloud database (SystemState); this script reads it every
 * 15 seconds and reports a heartbeat. Its role follows the switch:
 *
 *   Standby (MailFlow on the cloud) — only the database runs here. It pulls a full copy of the
 *     cloud database every night (03:00 IST) and on start-up if the last copy is over a day
 *     old, so the laptop always holds a recent backup. No app, no jobs. The one exception is
 *     "Send from the laptop" on a Recruiter Bulk Send: recruiter-runner.ts sends those sends'
 *     emails straight on the cloud database (saves Vercel CPU; no switch, no copy).
 *   Active (MailFlow on the laptop) — runs the app on 127.0.0.1:3100 (published through
 *     Tailscale Funnel; Vercel forwards the public address to it, middleware.ts) and every
 *     scheduled job. Pushes a full copy to the cloud every 30 minutes, so the cloud is at most
 *     30 minutes behind if the laptop disappears. If the public address stays unreachable for
 *     10 minutes, it hands MailFlow back to the cloud by itself.
 *   Handover — when someone switches on Settings → Server, everyone sees "switching servers";
 *     after a 30-second grace (so requests already on their way finish), this script copies
 *     the active database to the other one (laptop-server/copy-db.mjs: one transaction, row
 *     counts checked), then flips the switch. Before any copy *into* the laptop, the laptop's
 *     own data is backed up first (backups\pre-pull-*), so nothing here is ever lost.
 *
 * Without MAILFLOW_DATA\supabase.env there is no switch and the laptop is simply always active.
 * Postgres runs from ./node_modules (no installer), listens on 127.0.0.1 only, and is backed up
 * every night (7 days kept). If the app stops unexpectedly while active, it is restarted.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';
import { copyDatabase } from './copy-db.mjs';

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
  // The app knows it is the laptop's copy: as the active server it sends every Recruiter Bulk
  // Send, including those marked "Send from the laptop" (lib/recruiterSend/worker.ts).
  MAILFLOW_SERVER: 'laptop',
};
delete APP_ENV.REDIS_URL; // no Redis here: the database-backed send worker is used
delete APP_ENV.LAPTOP_UPSTREAM; // this IS the upstream

// The cloud database (Supabase): where the switch lives, and the other end of every copy.
// SUPABASE_DIRECT_URL (session pooler) is used here; the app reads the switch through the
// transaction pooler (CONTROL_DATABASE_URL, see lib/system/serverState.ts).
const SUPABASE = readEnvFile(path.join(DATA, 'supabase.env'));
const CLOUD_URL = SUPABASE.SUPABASE_DIRECT_URL || '';
const LOCAL_URL = DATABASE_URL.replace(/\?.*$/, '');
const LAPTOP_PUBLIC_URL = (APP_ENV.LAPTOP_PUBLIC_URL || '').replace(/\/+$/, '');
if (SUPABASE.SUPABASE_DATABASE_URL) APP_ENV.CONTROL_DATABASE_URL = SUPABASE.SUPABASE_DATABASE_URL;
// Archived files (signed PDFs, signing attachments) live here once the cloud copy is removed.
const FILES_DIR = path.join(DATA, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
APP_ENV.ARCHIVE_DIR = FILES_DIR;

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
// Postgres for Windows needs the Microsoft Visual C++ runtime. If Windows doesn't have it
// installed, copies kept in MAILFLOW_DATA\runtime are placed next to the Postgres programs
// (Microsoft's "app-local" deployment); reinstalling packages removes them, so check every start.
const PG_BIN = path.join(HERE, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
const VC_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
function ensureVcRuntime() {
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  for (const dll of VC_DLLS) {
    if (fs.existsSync(path.join(system32, dll)) || fs.existsSync(path.join(PG_BIN, dll))) continue;
    const local = path.join(DATA, 'runtime', dll);
    if (fs.existsSync(local)) fs.copyFileSync(local, path.join(PG_BIN, dll));
  }
}

let pgServer;
async function startDatabase() {
  ensureVcRuntime();
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
    const pgCtl = path.join(PG_BIN, 'pg_ctl.exe');
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

// An app left running by an earlier copy of this script (killed without a clean stop) still
// holds the port, so the new one could never start. Stop whatever is listening there first.
function freeAppPort() {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  const pids = new Set();
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const m = line.trim().split(/\s+/);
    if (m[1] === `127.0.0.1:${APP_PORT}` && m[3] === 'LISTENING' && Number(m[4]) !== process.pid) pids.add(m[4]);
  }
  for (const pid of pids) {
    log(`Stopping a leftover app (pid ${pid}) on port ${APP_PORT}.`);
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}

let wantApp = false;
function startApp() {
  wantApp = true;
  if (app) return;
  freeAppPort();
  log(`Starting the app on ${APP_LOCAL}…`);
  const out = fs.openSync(path.join(LOG_DIR, 'app.log'), 'a');
  const child = spawn(node, [NEXT_BIN, 'start', '-p', String(APP_PORT), '-H', '127.0.0.1'], { cwd: APP_DIR, env: APP_ENV, stdio: ['ignore', out, out], windowsHide: true });
  app = child;
  child.on('exit', (code) => {
    if (app === child) app = null;
    if (stopping || !wantApp) return;
    log(`App stopped (exit ${code}); restarting in 5 s.`);
    setTimeout(() => wantApp && startApp(), 5000);
  });
}

async function stopApp() {
  wantApp = false;
  const child = app;
  if (!child) return;
  log('Stopping the app.');
  child.kill();
  for (let i = 0; i < 20 && app === child; i++) await sleep(250);
  freeAppPort();
}

// ---------- laptop recruiter sender (standby) ----------
// "Send from the laptop" on a Recruiter Bulk Send (RecruiterBlast.runOn = 'laptop'): while this
// laptop is on STANDBY, recruiter-runner.ts sends those sends' emails straight on the CLOUD
// database with the app's own sender, so they cost no Vercel CPU. Not a server switch: nothing
// is copied and nobody sees "switching servers". While active, the app sends everything itself.
// Its own log: logs\recruiter-runner.log.
const TSX_LOADER = path.join(APP_DIR, 'node_modules', 'tsx');
// Prisma (the app's code) talks to the cloud through the transaction pooler, like CONTROL_DATABASE_URL.
const CLOUD_PRISMA_URL = SUPABASE.SUPABASE_DATABASE_URL || CLOUD_URL;
let runner = null;
let wantRunner = false;
let runnerMissingLogged = false;

/**
 * The sender's database link. The transaction pooler (port 6543) with ONE connection made every
 * query cost ~175 ms and queued them all (planning one round took 10 s; a 2,900-recruiter send
 * ran ~11 emails a minute however short the pause). The direct link takes ~35 ms a query, and 5
 * connections let a round's claims and checks run side by side.
 */
function runnerDbUrl() {
  if (!CLOUD_URL) return CLOUD_PRISMA_URL;
  try {
    const u = new URL(CLOUD_URL);
    u.searchParams.delete('pgbouncer');
    u.searchParams.set('connection_limit', '5');
    return u.toString();
  } catch {
    return CLOUD_PRISMA_URL;
  }
}

function runnerEnv() {
  const env = { ...APP_ENV, DATABASE_URL: runnerDbUrl(), DIRECT_URL: CLOUD_URL || CLOUD_PRISMA_URL };
  // Never the laptop's own database, never a hand-over to the local app, and not the active
  // server's "send everything" mode: the runner sends laptop sends only.
  delete env.CONTROL_DATABASE_URL;
  delete env.INTERNAL_APP_URL;
  delete env.MAILFLOW_SERVER;
  // A video attached to a send is read from Supabase Storage.
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) if (!env[k] && SUPABASE[k]) env[k] = SUPABASE[k];
  return env;
}

function startRecruiterRunner() {
  if (!CLOUD_PRISMA_URL || stopping) return;
  wantRunner = true;
  if (runner) return;
  if (!fs.existsSync(TSX_LOADER)) {
    if (!runnerMissingLogged) log(`Laptop recruiter sender not started: ${TSX_LOADER} is missing (run "npm install --include=dev" in ${APP_DIR}).`);
    runnerMissingLogged = true;
    return;
  }
  log('Starting the laptop recruiter sender (Recruiter Bulk Sends marked "Send from the laptop").');
  const out = fs.openSync(path.join(LOG_DIR, 'recruiter-runner.log'), 'a');
  const child = spawn(node, ['--import', 'tsx', path.join('laptop-server', 'recruiter-runner.ts')], { cwd: APP_DIR, env: runnerEnv(), stdio: ['pipe', out, out], windowsHide: true });
  runner = child;
  child.stdin.on('error', () => {});
  child.on('exit', (code) => {
    if (runner === child) runner = null;
    if (stopping || !wantRunner) return;
    log(`Laptop recruiter sender stopped (exit ${code}); restarting in 30 s.`);
    setTimeout(() => { if (wantRunner && role === 'standby' && !handingOver) startRecruiterRunner(); }, 30_000);
  });
}

/** Asks the runner to finish the message it is on and exit; forced after maxMs. */
async function stopRecruiterRunner(maxMs = 90_000) {
  wantRunner = false;
  const child = runner;
  if (!child) return;
  log('Stopping the laptop recruiter sender…');
  try { child.stdin.write('stop\n'); } catch {}
  for (let t = 0; t < maxMs && runner === child; t += 500) await sleep(500);
  if (runner === child) {
    log('The laptop recruiter sender did not stop in time; ending it.');
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    runner = null;
  }
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
  { name: 'recruiter-send', path: '/api/cron/recruiter-send?reason=laptop', everyMin: 1 },
  { name: 'gmail-sync', path: '/api/cron/gmail-sync', everyMin: 15 },
  { name: 'follow-ups', path: '/api/cron/follow-ups', everyMin: 15 },
  { name: 'sheets-sync', path: '/api/cron/sheets-sync', everyMin: 15 },
  { name: 'scheduled-send', path: '/api/cron/scheduled-send', dailyAt: [0, 0] },
  { name: 'scheduled-replies', path: '/api/cron/scheduled-replies', dailyAt: [0, 0] },
  // The 8 PM IST daily report (Mon–Fri; the route skips weekends and anything already sent).
  { name: 'daily-digest', path: '/api/cron/daily-digest', dailyAt: [14, 35] },
  { name: 'sla-check', path: '/api/cron/sla-check', dailyAt: [8, 0] },
  { name: 'signing-reminders', path: '/api/cron/signing-reminders', dailyAt: [9, 0] },
  { name: 'weekly-report', path: '/api/cron/weekly-report', dailyAt: [3, 30], weekday: 1 },
  // Old notifications / audit entries / sessions out, free-plan size warning (2 AM IST).
  { name: 'housekeeping', path: '/api/cron/housekeeping', dailyAt: [20, 30] },
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
  const due = lastDue(job, new Date(now));
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
    if (!res.ok || !['send-queue', 'recruiter-send'].includes(job.name) || /"sent":[1-9]/.test(body)) log(`[job] ${job.name} ${res.status} in ${Date.now() - started} ms ${body}`);
  } catch (err) {
    log(`[job] ${job.name} failed:`, String(err?.message ?? err));
  } finally {
    running.delete(job.name);
  }
}

// Backstop for the cloud while this laptop is on standby: every 2 minutes, look in the cloud
// database for a Recruiter Bulk Send that stopped moving (a dropped hand-over between sender
// runs) and only then ask the cloud to restart it. Checking the database directly means no
// Vercel call at all while nothing is stuck (Vercel Hobby CPU limits).
const CLOUD_APP = (APP_ENV.CLOUD_APP_URL || 'https://mailflowbymasai.vercel.app').replace(/\/+$/, '');
let lastCloudWatch = 0;
async function stuckCloudSends() {
  if (!control) return 1; // can't look: ask the cloud, as before
  // Times are stored in UTC without a time zone, so compare in SQL. Stuck = nothing sent or
  // claimed for longer than the send's pause plus 75 s (the cloud's own rule).
  const res = await control.query(`
    SELECT count(*)::int AS n FROM (
      SELECT b.id
      FROM "RecruiterBlast" b LEFT JOIN "RecruiterBlastGroup" g ON g."blastId" = b.id AND g."sentAt" IS NOT NULL
      WHERE b.status = 'SENDING' AND b."runOn" <> 'laptop'
      GROUP BY b.id, b."gapSeconds", b."startedAt"
      HAVING EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - COALESCE(MAX(g."sentAt"), b."startedAt", 'epoch'::timestamp))) > b."gapSeconds" + 75
    ) s`);
  return res.rows[0]?.n ?? 0;
}
async function tickCloudWatchdog() {
  if (role !== 'standby' || !APP_ENV.CRON_SECRET || Date.now() - lastCloudWatch < 115_000) return;
  lastCloudWatch = Date.now();
  try {
    if ((await stuckCloudSends()) === 0) return;
    const res = await fetch(`${CLOUD_APP}/api/cron/recruiter-watchdog`, { headers: { Authorization: `Bearer ${APP_ENV.CRON_SECRET}` }, signal: AbortSignal.timeout(20_000) });
    const body = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
    if (!res.ok || /"restarted":[1-9]/.test(body)) log(`[watchdog] cloud recruiter sends: ${res.status} ${body}`);
  } catch (err) {
    log('[watchdog] cloud check failed:', String(err?.message ?? err));
  }
}

function tickJobs() {
  tickCloudWatchdog();
  if (role !== 'active' || handingOver) return; // only the active server runs jobs
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
  await backupTo(new Date().toISOString().slice(0, 10));
  const all = fs.readdirSync(BACKUP_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
  for (const old of all.slice(0, -7)) fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
  const state = readState();
  state.lastBackup = Date.now();
  writeState(state);
}

/** Before anything is copied into the laptop database, keep what is there (last 5 kept). */
async function backupBeforePull() {
  await backupTo(`pre-pull-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const all = fs.readdirSync(BACKUP_DIR).filter((n) => n.startsWith('pre-pull-')).sort();
  for (const old of all.slice(0, -5)) fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
}

async function backupTo(name) {
  const dir = path.join(BACKUP_DIR, name);
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

// ---------- public address watchdog ----------
// Every minute, load /api/ping through the public address (Vercel → Tailscale Funnel → here),
// the same way the team reaches the app. Testing the Funnel address directly from this laptop
// proves nothing: Tailscale short-cuts it locally. When the route has been down for 3 minutes,
// the Funnel setting for the app is switched off and on again (at most every 10 minutes).
// Only the app's own port (443 → 3100) is touched; other Funnel entries are left alone.
const PUBLIC_URL = (APP_ENV.NEXTAUTH_URL || '').replace(/\/+$/, '');
const TAILSCALE = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
let publicUp = null;
let publicFails = 0;
let publicDownSince = 0;
let lastRepair = 0;
const HAND_BACK_AFTER_MS = 10 * 60_000;

async function checkPublicRoute() {
  if (!PUBLIC_URL.startsWith('https://')) return;
  if (role !== 'active' || handingOver) {
    publicUp = null;
    publicFails = 0;
    publicDownSince = 0;
    return; // on standby the public address is served by the cloud: nothing to watch
  }
  let ok = false;
  let detail = '';
  try {
    const res = await fetch(`${PUBLIC_URL}/api/ping?watchdog=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    ok = res.ok;
    detail = res.headers.get('x-vercel-error') || String(res.status);
  } catch (err) {
    detail = String(err?.cause?.code || err?.message || err);
  }
  if (ok !== publicUp) log(ok ? 'Public address is reachable.' : `Public address is NOT reachable (${detail}).`);
  publicUp = ok;
  publicFails = ok ? 0 : publicFails + 1;
  publicDownSince = ok ? 0 : publicDownSince || Date.now();
  // Unreachable for 10 minutes: the team can't use MailFlow, so hand it back to the cloud
  // (a normal handover with a full copy — nothing is lost).
  if (publicDownSince && Date.now() - publicDownSince >= HAND_BACK_AFTER_MS && CLOUD_URL) {
    await requestSwitchToCloud('the laptop server (its public address was unreachable for 10 minutes)');
    return;
  }
  if (publicFails < 3 || Date.now() - lastRepair < 10 * 60_000 || !fs.existsSync(TAILSCALE)) return;
  lastRepair = Date.now();
  log('Switching the Tailscale Funnel for the app off and on again…');
  const ts = (args) => {
    const r = spawnSync(TAILSCALE, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return `${r.status} ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-2).join(' | ')}`;
  };
  log('  off:', ts(['funnel', '--yes', '--https=443', 'off']));
  log('  on: ', ts(['funnel', '--yes', '--bg', '--https=443', `http://127.0.0.1:${APP_PORT}`]));
}

// ---------- server switch ----------
// role: 'active' (MailFlow runs here) | 'standby' (MailFlow runs on the cloud) | null (not known yet)
let role = null;
let handingOver = false;
let controlDownLogged = false;
const GRACE_MS = 30_000; // requests already on their way finish before a copy starts
const PUSH_EVERY_MS = 30 * 60_000;
const control = CLOUD_URL ? new pg.Pool({ connectionString: CLOUD_URL, ssl: { rejectUnauthorized: false }, max: 2 }) : null;
control?.on('error', () => {}); // a dropped idle connection is reopened on the next query

const fmtIst = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

/** Heartbeat + read the switch in one round trip. updatedAt is left alone: it marks real changes. */
async function heartbeat() {
  const { rows } = await control.query(
    `INSERT INTO "SystemState" (id, "updatedAt", "lastLaptopSeenAt", "laptopUrl") VALUES ('main', now(), now(), $1)
     ON CONFLICT (id) DO UPDATE SET "lastLaptopSeenAt" = now(), "laptopUrl" = COALESCE($1, "SystemState"."laptopUrl")
     RETURNING *`,
    [LAPTOP_PUBLIC_URL || null],
  );
  return rows[0];
}

// SystemState's times are stored without a time zone, in UTC (Prisma's convention). Times are
// therefore always written by the database (NOW → now()) and read back as UTC: passing a JS
// Date would store this laptop's local (IST) wall-clock time instead.
const NOW = Symbol('now');
pg.types.setTypeParser(1114, (v) => new Date(v.replace(' ', 'T') + 'Z'));

async function setState(where, fields) {
  const keys = Object.keys(fields);
  const params = [];
  const sets = keys.map((k) => (fields[k] === NOW ? `"${k}" = now()` : (params.push(fields[k]), `"${k}" = ${params.length}`))).join(', ');
  const res = await control.query(`UPDATE "SystemState" SET ${sets}, "updatedAt" = now() WHERE id = 'main' AND ${where}`, params);
  return res.rowCount > 0;
}

async function requestSwitchToCloud(by) {
  const ok = await setState(`"activeServer" = 'laptop' AND "switchTo" IS NULL`, { switchTo: 'cloud', switchStartedAt: NOW, switchRequestedBy: by, note: null }).catch(() => false);
  if (ok) log(`Asked to move MailFlow to the cloud (${by}).`);
}

// ---------- standby file server ----------
// On standby the app isn't running, but the cloud still fetches archived files from this
// laptop (lib/storage/files.ts → /api/archive/…). This small server answers on the app's port
// until the app starts again; same signed, 5-minute links as app/api/archive.
let standbyServer = null;
const ARCHIVE_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

function archiveSig(rel, exp) {
  return createHmac('sha256', APP_ENV.CRON_SECRET ?? '').update(`${rel}\n${exp}`).digest('hex').slice(0, 32);
}

function startStandbyServer() {
  if (standbyServer) return;
  freeAppPort();
  standbyServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, standby: true }));
    }
    const m = url.pathname.match(/^\/api\/archive\/(.+)$/);
    if (!m) {
      res.writeHead(404);
      return res.end();
    }
    const rel = m[1].split('/').map(decodeURIComponent).join('/');
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig') ?? '';
    const expected = archiveSig(rel, exp);
    const full = path.resolve(FILES_DIR, rel);
    const ok = Number.isFinite(exp) && exp > Date.now() && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) && full.startsWith(path.resolve(FILES_DIR) + path.sep);
    if (!ok) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': ARCHIVE_TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'private, no-store' });
      res.end(data);
    });
  });
  standbyServer.on('error', (e) => log('Standby file server:', String(e?.message ?? e)));
  standbyServer.listen(APP_PORT, '127.0.0.1');
}

async function stopStandbyServer() {
  if (!standbyServer) return;
  const s = standbyServer;
  standbyServer = null;
  await new Promise((resolve) => s.close(() => resolve()));
}

// ---------- archiving finished files ----------
// Once a signing request is final, its files move from Supabase Storage to this laptop
// (FILES_DIR): download, write, read back and compare, point the database at the archive copy,
// then delete the cloud copy — keeping Supabase within its free 1 GB.
const STORAGE_URL = (SUPABASE.SUPABASE_URL || '').replace(/\/+$/, '');
const STORAGE_KEY = SUPABASE.SUPABASE_SERVICE_KEY || '';
const BUCKET = 'mailflow-files';
const storageHeaders = { Authorization: `Bearer ${STORAGE_KEY}`, apikey: STORAGE_KEY };
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function archiveRef(ref) {
  const rel = ref.slice('storage:'.length);
  const res = await fetch(`${STORAGE_URL}/storage/v1/object/${BUCKET}/${encodePath(rel)}`, { headers: storageHeaders });
  if (!res.ok) throw new Error(`download ${rel}: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const dest = path.resolve(FILES_DIR, rel);
  if (!dest.startsWith(path.resolve(FILES_DIR) + path.sep)) throw new Error(`unsafe path ${rel}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.partial`, data);
  fs.renameSync(`${dest}.partial`, dest);
  const check = fs.readFileSync(dest);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  if (check.length !== data.length || sha(check) !== sha(data)) throw new Error(`verify ${rel} failed`);
  return { rel, archived: `archive:${rel}` };
}

async function deleteFromStorage(rel) {
  await fetch(`${STORAGE_URL}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: { ...storageHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ prefixes: [rel] }),
  }).catch(() => undefined);
}

let archiving = false;
let lastArchive = 0;
async function tickArchive() {
  if (!control || !STORAGE_URL || !STORAGE_KEY || archiving || Date.now() - lastArchive < 6 * 3600_000) return;
  archiving = true;
  lastArchive = Date.now();
  let moved = 0;
  try {
    const { rows: requests } = await control.query(
      `SELECT id, "signedPdfData" AS pdf, attachments FROM "SigningRequest"
       WHERE status IN ('SIGNED', 'VOIDED', 'EXPIRED') AND ("signedPdfData" LIKE 'storage:%' OR attachments::text LIKE '%"storage:%') LIMIT 200`,
    );
    for (const r of requests) {
      if (r.pdf?.startsWith('storage:')) {
        const a = await archiveRef(r.pdf);
        const u = await control.query(`UPDATE "SigningRequest" SET "signedPdfData" = $1 WHERE id = $2 AND "signedPdfData" = $3`, [a.archived, r.id, r.pdf]);
        if (u.rowCount) { await deleteFromStorage(a.rel); moved++; }
      }
      const list = Array.isArray(r.attachments) ? r.attachments : [];
      if (list.some((x) => typeof x?.url === 'string' && x.url.startsWith('storage:'))) {
        const done = [];
        const next = [];
        for (const x of list) {
          if (typeof x?.url === 'string' && x.url.startsWith('storage:')) {
            const a = await archiveRef(x.url);
            done.push(a.rel);
            next.push({ ...x, url: a.archived });
          } else next.push(x);
        }
        const u = await control.query(`UPDATE "SigningRequest" SET attachments = $1::jsonb WHERE id = $2 AND attachments::text = $3::jsonb::text`, [JSON.stringify(next), r.id, JSON.stringify(list)]);
        if (u.rowCount) for (const rel of done) { await deleteFromStorage(rel); moved++; }
      }
    }
    const { rows: groups } = await control.query(
      `SELECT id, "combinedPdfData" AS pdf FROM "SigningGroup" WHERE status IN ('COMPLETED', 'VOIDED') AND "combinedPdfData" LIKE 'storage:%' LIMIT 200`,
    );
    for (const g of groups) {
      const a = await archiveRef(g.pdf);
      const u = await control.query(`UPDATE "SigningGroup" SET "combinedPdfData" = $1 WHERE id = $2 AND "combinedPdfData" = $3`, [a.archived, g.id, g.pdf]);
      if (u.rowCount) { await deleteFromStorage(a.rel); moved++; }
    }
    if (moved) log(`Archived ${moved} finished file(s) to this laptop and freed the cloud copies.`);
  } catch (err) {
    log('Archiving files failed (will retry):', String(err?.message ?? err));
    lastArchive = Date.now() - 5 * 3600_000; // retry in about an hour
  } finally {
    archiving = false;
  }
}

async function becomeActive() {
  if (role === 'active') return;
  role = 'active';
  log('Role: ACTIVE — MailFlow runs on this laptop.');
  await stopRecruiterRunner(); // the app sends every recruiter send from now on
  await stopStandbyServer();
  startApp();
  if (await waitForApp()) tickJobs();
}

async function becomeStandby() {
  if (role === 'standby') return;
  role = 'standby';
  log('Role: STANDBY — MailFlow runs on the cloud; this laptop keeps a copy.');
  await stopApp();
  startStandbyServer();
}

async function waitForJobs(maxMs) {
  for (let t = 0; running.size && t < maxMs; t += 500) await sleep(500);
}

async function handoverToLaptop(s) {
  handingOver = true;
  try {
    const wait = new Date(s.switchStartedAt).getTime() + GRACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    if ((await heartbeat()).switchTo !== 'laptop') return; // cancelled meanwhile
    // Nothing may write to the cloud during the copy (the app here takes over laptop sends after).
    await stopRecruiterRunner();
    log('Switching to the laptop: copying the cloud database here…');
    await backupBeforePull();
    const r = await copyDatabase(CLOUD_URL, LOCAL_URL);
    log(`Copied ${r.rows} rows from the cloud.`);
    await stopStandbyServer();
    startApp();
    if (!(await waitForApp())) throw new Error('the app did not start');
    const done = await setState(`"switchTo" = 'laptop'`, {
      activeServer: 'laptop', switchTo: null, switchStartedAt: null, lastSyncAt: NOW,
      note: `Switched to the laptop on ${fmtIst(Date.now())}.`,
    });
    if (!done) {
      log('The switch was cancelled while copying; staying on standby.');
      await stopApp();
      startStandbyServer();
      return;
    }
    role = 'active';
    lastPush = Date.now();
    log('Role: ACTIVE — switch to the laptop complete.');
    tickJobs();
  } catch (err) {
    log('Switch to the laptop failed:', err);
    await stopApp();
    startStandbyServer();
    await setState(`"switchTo" = 'laptop'`, {
      switchTo: null, switchStartedAt: null,
      note: `The switch to the laptop failed (${String(err?.message ?? err).slice(0, 200)}). MailFlow stayed on the cloud; nothing was lost.`,
    }).catch(() => {});
  } finally {
    handingOver = false;
  }
}

async function handoverToCloud(s) {
  handingOver = true; // jobs stop starting from now
  try {
    const wait = new Date(s.switchStartedAt).getTime() + GRACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    if ((await heartbeat()).switchTo !== 'cloud') return;
    await waitForJobs(120_000);
    await stopApp();
    log('Switching to the cloud: copying this laptop\'s database there…');
    const r = await copyDatabase(LOCAL_URL, CLOUD_URL);
    log(`Copied ${r.rows} rows to the cloud.`);
    await setState(`"switchTo" = 'cloud'`, {
      activeServer: 'cloud', switchTo: null, switchStartedAt: null, lastSyncAt: NOW,
      note: `Switched to the cloud on ${fmtIst(Date.now())}${s.switchRequestedBy ? ` (requested by ${s.switchRequestedBy})` : ''}.`,
    });
    role = 'standby';
    startStandbyServer();
    state_lastPull(Date.now());
    log('Role: STANDBY — switch to the cloud complete.');
  } catch (err) {
    log('Switch to the cloud failed:', err);
    await setState(`"switchTo" = 'cloud'`, {
      switchTo: null, switchStartedAt: null,
      note: `The switch to the cloud failed (${String(err?.message ?? err).slice(0, 200)}). MailFlow stayed on the laptop; nothing was lost.`,
    }).catch(() => {});
    role = null; // re-evaluated (and the app restarted) on the next tick
  } finally {
    handingOver = false;
  }
}

// Active: keep the cloud at most 30 minutes behind, in case this laptop disappears. A copy
// rewrites the whole cloud database, so it is skipped when nothing changed here since the
// last one (Postgres's own insert/update/delete counters for this database).
let lastPush = Date.now();
let pushing = false;
let pushedFingerprint = null;
const MB = 1024 * 1024;
async function localWriteFingerprint() {
  const c = new pg.Client({ connectionString: LOCAL_URL });
  await c.connect();
  try {
    const { rows } = await c.query(`SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text AS n FROM pg_stat_user_tables`);
    return rows[0]?.n ?? null;
  } finally {
    await c.end().catch(() => {});
  }
}
async function tickPush() {
  if (role !== 'active' || handingOver || pushing || Date.now() - lastPush < PUSH_EVERY_MS) return;
  pushing = true;
  try {
    const fingerprint = await localWriteFingerprint().catch(() => null);
    if (fingerprint !== null && fingerprint === pushedFingerprint) {
      lastPush = Date.now();
      log('Nothing changed since the last copy to the cloud; skipped.');
      return;
    }
    const r = await copyDatabase(LOCAL_URL, CLOUD_URL);
    lastPush = Date.now();
    pushedFingerprint = fingerprint;
    await setState('true', { lastSyncAt: NOW });
    log(`Copied ${r.rows} rows (${(r.bytes / MB).toFixed(1)} MB) to the cloud (standby copy).`);
  } catch (err) {
    log('Copy to the cloud failed (will retry):', String(err?.message ?? err));
  } finally {
    pushing = false;
  }
}

// Standby: pull the cloud database at 03:00 IST, and on start-up when a pull is overdue. Every
// pull is Supabase egress the size of the whole database (free plan: 5 GB a month), so it is
// nightly while the database is under 150 MB and every third night above that.
const PULL_DAILY_BELOW_BYTES = 150 * 1024 * 1024;
async function pullIntervalDays() {
  try {
    const { rows } = await control.query('SELECT pg_database_size(current_database())::bigint AS b');
    return Number(rows[0]?.b ?? 0) < PULL_DAILY_BELOW_BYTES ? 1 : 3;
  } catch {
    return 1;
  }
}
function state_lastPull(t) {
  const st = readState();
  st.lastPull = t;
  writeState(st);
}
let pulling = false;
async function tickPull() {
  if (role !== 'standby' || handingOver || pulling) return;
  const last = readState().lastPull ?? 0;
  const now = new Date();
  const dueToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 30));
  const lastDueAt = dueToday <= now ? dueToday : new Date(dueToday.getTime() - 86_400_000);
  if (last >= lastDueAt.getTime() && Date.now() - last < 86_400_000) return;
  pulling = true;
  try {
    // Every N days: the last pull must be at least N days (less half a day of slack) old.
    const days = await pullIntervalDays();
    if (days > 1 && Date.now() - last < days * 86_400_000 - 12 * 3600_000) return;
    await backupBeforePull();
    const r = await copyDatabase(CLOUD_URL, LOCAL_URL);
    state_lastPull(Date.now());
    await setState('true', { lastSyncAt: NOW });
    log(`Pulled ${r.rows} rows (${(r.bytes / MB).toFixed(1)} MB of Supabase egress) from the cloud (laptop backup copy).`);
  } catch (err) {
    log('Pulling the cloud copy failed (will retry):', String(err?.message ?? err));
  } finally {
    pulling = false;
  }
}

// ---------- timer watch ----------
// The 15-minute /api/cron/dispatch (GitHub Actions / Supabase timer) drives cloud sending and the
// 8 PM report; it stamps SystemState.lastDispatchAt. If that is over 6 hours old while the cloud
// is active, say so in the log and in Slack (at most every 6 hours). Free: the heartbeat already
// reads the row.
const DISPATCH_STALE_MS = 6 * 3600_000;
let lastDispatchWarnAt = 0;
async function watchDispatch(s) {
  if (s.activeServer !== 'cloud' || !s.lastDispatchAt) return;
  const age = Date.now() - new Date(s.lastDispatchAt).getTime();
  if (age < DISPATCH_STALE_MS || Date.now() - lastDispatchWarnAt < DISPATCH_STALE_MS) return;
  lastDispatchWarnAt = Date.now();
  const text = `MailFlow's 15-minute timer hasn't run since ${fmtIst(s.lastDispatchAt)} (IST). Cloud sends rely on the laptop watchdog until it runs again: check the GitHub "scheduled-jobs" workflow or the Supabase timer.`;
  log(`Warning: ${text}`);
  const token = APP_ENV.SLACK_BOT_TOKEN?.trim();
  if (!token) return;
  // A warning goes to one person as a private message, not to the team channel.
  const to = APP_ENV.SLACK_ALERT_USER_ID?.trim() || 'U04DRTCE9L4';
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: to, text: `:warning: ${text}` }),
  });
}

async function controlTick() {
  if (handingOver) return;
  let s;
  try {
    s = await heartbeat();
    if (controlDownLogged) log('Cloud database reachable again.');
    controlDownLogged = false;
  } catch (err) {
    // Can't reach the cloud: keep doing what we're doing (an active laptop keeps serving).
    if (!controlDownLogged) log('Cannot reach the cloud database:', String(err?.message ?? err));
    controlDownLogged = true;
    return;
  }
  watchDispatch(s).catch(() => {});
  if (s.switchTo === 'laptop' && s.activeServer === 'cloud') return handoverToLaptop(s);
  if (s.switchTo === 'cloud' && s.activeServer === 'laptop') return handoverToCloud(s);
  if (s.switchTo) return; // the other side's move; wait
  if (s.activeServer === 'laptop') await becomeActive();
  else {
    await becomeStandby();
    startRecruiterRunner(); // (again) after a cancelled or failed switch; no-op while running
  }
}

// ---------- restart on request ----------
// Creating MAILFLOW_DATA\restart.request makes this copy stop cleanly (app and database included);
// the Startup script starts a fresh one within a minute. Used after shipping new code.
const RESTART_FILE = path.join(DATA, 'restart.request');

// ---------- shutdown ----------
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`Stopping (${signal})…`);
  try { app?.kill(); } catch {}
  // The recruiter sender finishes the message it is on and exits by itself.
  try { runner?.stdin.write('stop\n'); } catch {}
  await sleep(1500);
  try { await pgServer?.stop(); } catch (e) { log('Database stop:', String(e)); }
  try { fs.rmSync(LOCK_FILE, { force: true }); } catch {}
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => shutdown(sig));
process.on('uncaughtException', (e) => log('Unexpected error:', e));
process.on('unhandledRejection', (e) => log('Unexpected error:', e));

// ---------- go ----------
function fail(message) {
  log(`Could not start: ${message}`);
  try { fs.rmSync(LOCK_FILE, { force: true }); } catch {}
  process.exit(1);
}

log(`MailFlow laptop server starting (app ${APP_DIR}, data ${DATA}).`);
try {
  await startDatabase();
} catch (err) {
  // 0xC0000135: a DLL is missing, almost always the Microsoft Visual C++ runtime.
  const hint = /3221225781/.test(String(err?.message)) ? ' (missing Microsoft Visual C++ runtime: see README.md)' : '';
  fail(`database: ${String(err?.message ?? err).trim()}${hint}`);
}
// A brand-new database is created straight from prisma/schema.prisma and the migration
// history is marked as applied: replaying every old migration from scratch fails (two of them
// create the SlaRule table). From then on new migrations apply normally.
async function isFreshDatabase() {
  const client = new pg.Client({ connectionString: DATABASE_URL.replace(/\?.*$/, '') });
  await client.connect();
  try {
    const { rows } = await client.query(`select to_regclass('public._prisma_migrations') is null as fresh`);
    return rows[0].fresh;
  } finally {
    await client.end();
  }
}
if (await isFreshDatabase()) {
  if (!runStep('Creating the tables', [PRISMA_BIN, 'db', 'push', '--skip-generate'])) fail('creating tables');
  const migrations = fs.readdirSync(path.join(APP_DIR, 'prisma', 'migrations')).filter((n) => fs.existsSync(path.join(APP_DIR, 'prisma', 'migrations', n, 'migration.sql'))).sort();
  for (const name of migrations) {
    if (!runStep(`Marking migration ${name} as applied`, [PRISMA_BIN, 'migrate', 'resolve', '--applied', name])) fail('marking migrations');
  }
}
if (!runStep('Applying database migrations', [PRISMA_BIN, 'migrate', 'deploy'])) fail('migrations');
// Rebuild whenever the code changed since the last build (git commit of the app folder), so a
// switch to the laptop never runs an older MailFlow than the cloud.
const BUILT_FILE = path.join(DATA, 'built-commit.txt');
// New or changed packages (package-lock.json changed) are installed first; otherwise a version
// that adds a library fails to build here ("Module not found") while the cloud builds fine.
const DEPS_FILE = path.join(DATA, 'deps-hash.txt');
const PACKAGE_LOCK = path.join(APP_DIR, 'package-lock.json');
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const depsHash = fs.existsSync(PACKAGE_LOCK) ? createHash('sha256').update(fs.readFileSync(PACKAGE_LOCK)).digest('hex') : '';
if (depsHash && (!fs.existsSync(DEPS_FILE) || fs.readFileSync(DEPS_FILE, 'utf8').trim() !== depsHash)) {
  if (!fs.existsSync(NPM_CLI)) {
    log(`npm was not found next to Node (${NPM_CLI}); if the build fails, run "npm install" in ${APP_DIR}.`);
  } else if (runStep('Installing packages (package-lock.json changed)', [NPM_CLI, 'install', '--include=dev', '--no-audit', '--no-fund'])) {
    fs.writeFileSync(DEPS_FILE, depsHash);
  } else {
    fail('npm install');
  }
}
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8', windowsHide: true }).stdout?.trim() || 'unknown';
const builtCommit = fs.existsSync(BUILT_FILE) ? fs.readFileSync(BUILT_FILE, 'utf8').trim() : '';
if (!fs.existsSync(path.join(APP_DIR, '.next', 'BUILD_ID')) || builtCommit !== commit) {
  if (!runStep(`Building the app for ${commit.slice(0, 7)} (takes a few minutes)`, [PRISMA_BIN, 'generate'])) fail('prisma generate');
  if (!runStep('Building the app', [NEXT_BIN, 'build'])) fail('build');
  fs.writeFileSync(BUILT_FILE, commit);
}
if (control) {
  log(`Server switch: following the cloud database${LAPTOP_PUBLIC_URL ? `; public address ${LAPTOP_PUBLIC_URL}` : ' (LAPTOP_PUBLIC_URL not set in app.env!)'}.`);
  await controlTick();
  setInterval(controlTick, 15_000);
  setInterval(tickPush, 60_000);
  setInterval(tickPull, 5 * 60_000);
  setTimeout(tickArchive, 60_000);
  setInterval(tickArchive, 15 * 60_000);
  setTimeout(tickPull, 20_000);
} else {
  log('No supabase.env: no server switch, this laptop is always the active server.');
  await becomeActive();
}
log('Ready.');
setInterval(tickJobs, 20_000);
tickBackup();
setInterval(tickBackup, 10 * 60_000);
fs.rmSync(RESTART_FILE, { force: true });
setInterval(() => {
  if (!fs.existsSync(RESTART_FILE)) return;
  fs.rmSync(RESTART_FILE, { force: true });
  shutdown('restart requested');
}, 5000);
setTimeout(() => {
  checkPublicRoute();
  setInterval(checkPublicRoute, 60_000);
}, 30_000);
