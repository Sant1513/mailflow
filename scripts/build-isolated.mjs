/**
 * Runs `next build` into a SEPARATE output directory.
 *
 * Why this exists: `next build` and `next dev` both use `.next` by default,
 * so running a verification build while the dev server is up deletes the
 * dev chunks the browser is still requesting. The running app then serves
 * every JS/CSS bundle as a 404 — the page renders unstyled and buttons stop
 * responding, because React never hydrates. It looks like a broken app
 * rather than a clobbered build directory, which makes it genuinely
 * confusing to debug.
 *
 * `npm run verify` uses this so it is always safe to run mid-development.
 */
import { spawn } from 'node:child_process';

const distDir = process.env.NEXT_DIST_DIR || '.next-verify';

const child = spawn('npx', ['next', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NEXT_DIST_DIR: distDir },
});

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  console.error('Failed to start next build:', err);
  process.exit(1);
});
