/**
 * `npm run build`. Applies database migrations, then builds the app.
 *
 * When this deployment is only the front door for the laptop server (LAPTOP_UPSTREAM is
 * set, see middleware.ts), it never touches a database, so migrations are skipped: the
 * laptop applies them to its own database when it starts (laptop-server/start.mjs).
 */
import { spawnSync } from 'node:child_process';

function run(cmd) {
  console.log(`> ${cmd}`);
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (process.env.LAPTOP_UPSTREAM) console.log('LAPTOP_UPSTREAM is set: skipping migrations (front door only).');
else run('npx prisma migrate deploy');
run('npx prisma generate');
run('npx next build');
