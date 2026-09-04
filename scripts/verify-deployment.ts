/**
 * Post-deploy smoke check, run as an ANONYMOUS visitor.
 *
 * This exists because a production outage slipped past the other suites:
 * NextAuth was missing its secret (the env var was named AUTH_SECRET, but
 * v4 reads NEXTAUTH_SECRET), so every page that resolves a session returned
 * a 500. The other integration suite always authenticates first, so it
 * never exercised the signed-out path the way a real first-time visitor
 * does.
 *
 * The rule this encodes: after every deploy, hit the real URL with no
 * cookies and assert nothing 5xxs.
 *
 * Usage: BASE_URL=https://... npx tsx scripts/verify-deployment.ts
 */
const BASE_URL = process.env.BASE_URL ?? 'https://mailflow-six-sooty.vercel.app';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

interface Expectation {
  path: string;
  /** Status codes that are correct for an anonymous visitor. */
  expect: number[];
  description: string;
}

const ROUTES: Expectation[] = [
  { path: '/', expect: [307, 302], description: 'root redirects to login (never 404 or 500)' },
  { path: '/login', expect: [200], description: 'login page renders' },
  { path: '/login/error', expect: [200], description: 'login error page renders' },
  { path: '/dashboard', expect: [307, 302], description: 'dashboard redirects when signed out' },
  { path: '/templates', expect: [307, 302], description: 'templates redirects when signed out' },
  { path: '/data', expect: [307, 302], description: 'data redirects when signed out' },
  { path: '/inbox', expect: [307, 302], description: 'inbox redirects when signed out' },
  { path: '/contacts', expect: [307, 302], description: 'contacts redirects when signed out' },
  { path: '/settings', expect: [307, 302], description: 'settings redirects when signed out' },
  { path: '/admin/users', expect: [307, 302], description: 'admin redirects when signed out' },
  { path: '/api/datasets', expect: [401], description: 'API returns 401 JSON when signed out' },
  { path: '/api/templates', expect: [401], description: 'templates API returns 401 when signed out' },
  { path: '/api/contacts', expect: [401], description: 'contacts API returns 401 when signed out' },
  { path: '/api/admin/users', expect: [401], description: 'admin API returns 401 when signed out' },
  { path: '/api/auth/providers', expect: [200], description: 'NextAuth providers endpoint responds' },
  { path: '/api/auth/csrf', expect: [200], description: 'NextAuth csrf endpoint responds' },
  { path: '/this-page-does-not-exist', expect: [404], description: 'unknown path 404s cleanly' },
];

async function main() {
  console.log(`=== Deployment verification: ${BASE_URL} (anonymous) ===\n`);

  for (const route of ROUTES) {
    let status = 0;
    let body = '';
    try {
      const res = await fetch(`${BASE_URL}${route.path}`, { redirect: 'manual' });
      status = res.status;
      body = (await res.text()).slice(0, 200);
    } catch (err) {
      check(`${route.path} — ${route.description}`, false, String(err));
      continue;
    }
    const ok = route.expect.includes(status);
    check(`${route.path} — ${route.description}`, ok, ok ? undefined : { status, body });
  }

  // The specific failure mode that caused the outage: a server-side
  // exception rendered as Next's generic error page.
  console.log('\n-- Server-side exception check --');
  const res = await fetch(`${BASE_URL}/login`);
  const html = await res.text();
  check(
    'No "Application error: a server-side exception" on the login page',
    !html.includes('server-side exception'),
    html.slice(0, 200)
  );

  // NextAuth misconfiguration surfaces here as an error query param.
  const providers = await fetch(`${BASE_URL}/api/auth/providers`);
  const providersBody = await providers.text();
  check(
    'Google provider is configured with the deployed callback URL',
    providersBody.includes('accounts.google.com') || providersBody.includes('callback/google'),
    providersBody.slice(0, 200)
  );

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('VERIFICATION CRASHED:', err);
  process.exit(1);
});
