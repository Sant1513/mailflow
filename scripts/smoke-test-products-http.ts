/**
 * Mail / Sign product split — HTTP smoke test. A throwaway user + session is
 * created, the entry redirects, the chooser and each product's sidebar are
 * checked over HTTP, then everything is deleted.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/smoke-test-products-http.ts
 * Set KEEP_SESSION=1 to print a fixture session cookie for a manual browser check
 * (the fixture is then left in place; re-run without it to clean up).
 */
import 'dotenv/config';
import { prisma } from '../lib/db/client';
import { Role } from '@prisma/client';
import crypto from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SESSION_COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '');
  }
}

async function get(path: string, cookie: string | null) {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, location: res.headers.get('location') ?? '', text: await res.text() };
}

const sidebarOf = (html: string) => (/aria-label="(Mail|Sign) navigation"/.exec(html)?.[1] ?? null);

/** Removes fixture users left behind by earlier KEEP_SESSION runs. */
async function removeLeftoverFixtures() {
  const leftovers = await prisma.user.findMany({
    where: { email: { startsWith: 'prod-split+' }, googleId: { startsWith: 'prod-split-' } },
    select: { id: true },
  });
  for (const u of leftovers) {
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.workspace.deleteMany({ where: { ownerId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }
  if (leftovers.length) console.log(`Removed ${leftovers.length} leftover fixture user(s).\n`);
}

async function main() {
  console.log(`=== MailFlow product split smoke test against ${BASE_URL} ===\n`);
  await removeLeftoverFixtures();
  if (process.env.CLEANUP_ONLY === '1') {
    await prisma.$disconnect();
    return;
  }
  const stamp = Date.now();
  const org = await prisma.organization.upsert({
    where: { allowedDomain: 'masaischool.com' },
    update: {},
    create: { name: 'Masai School', allowedDomain: 'masaischool.com' },
  });
  const user = await prisma.user.create({
    data: { organizationId: org.id, googleId: `prod-split-${stamp}`, email: `prod-split+${stamp}@masaischool.com`, name: 'Product Split Tester', role: Role.OPERATOR },
  });
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: user.id, name: `Product split WS ${stamp}` } });
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3600_000) } });
  const auth = `${SESSION_COOKIE}=${sessionToken}`;

  try {
    console.log('Entry and chooser');
    const signedOut = await get('/choose', null);
    check('signed-out /choose goes to login', signedOut.status >= 300 && signedOut.status < 400 && signedOut.location.includes('/login'), signedOut);

    const noPref = await get('/', auth);
    check('sign-in landing without a saved choice opens the chooser', noPref.location.endsWith('/choose'), noPref.location);

    const prefSign = await get('/', `${auth}; mf_default_product=sign`);
    check('saved choice "sign" opens Sign', prefSign.location.endsWith('/documents'), prefSign.location);

    const prefMail = await get('/', `${auth}; mf_default_product=mail`);
    check('saved choice "mail" opens Mail', prefMail.location.endsWith('/dashboard'), prefMail.location);

    const junk = await get('/', `${auth}; mf_default_product=admin`);
    check('an invalid saved choice falls back to the chooser', junk.location.endsWith('/choose'), junk.location);

    const chooser = await get('/choose', auth);
    check('chooser renders', chooser.status === 200 && chooser.text.includes('where do you want to go'), chooser.status);
    check('chooser offers both products', chooser.text.includes('Open Mail') && chooser.text.includes('Open Sign'));

    console.log('\nSidebars');
    const cases: [string, string | null, 'Mail' | 'Sign'][] = [
      ['/dashboard', null, 'Mail'],
      ['/campaigns', null, 'Mail'],
      ['/documents/library', null, 'Mail'],
      ['/documents', null, 'Sign'],
      ['/documents/bulk', null, 'Sign'],
      ['/documents/templates', null, 'Sign'],
      ['/settings', 'mail', 'Mail'],
      ['/settings', 'sign', 'Sign'],
    ];
    for (const [path, current, expected] of cases) {
      const cookie = current ? `${auth}; mf_product=${current}` : auth;
      const page = await get(path, cookie);
      check(`${path}${current ? ` (came from ${current})` : ''} shows the ${expected} sidebar`, page.status === 200 && sidebarOf(page.text) === expected, { status: page.status, sidebar: sidebarOf(page.text) });
    }

    const sign = await get('/documents', auth);
    check('Sign sidebar lists Sign items only', sign.text.includes('href="/documents/bulk"') && !sign.text.includes('href="/campaigns"'));
    check('Sign pages are branded MailFlow Sign', sign.text.includes('MailFlow <!-- -->Sign') || sign.text.includes('MailFlow Sign'));
    const mail = await get('/dashboard', auth);
    check('Mail sidebar lists Mail items only', mail.text.includes('href="/campaigns"') && !mail.text.includes('href="/documents/bulk"'));
    check('switcher is on every page', sign.text.includes('aria-label="Product"') && mail.text.includes('aria-label="Product"'));
  } finally {
    if (process.env.KEEP_SESSION === '1') {
      console.log(`\nKEEP_SESSION: fixture user ${user.email} left in place. Cookie: ${SESSION_COOKIE}=${sessionToken}`);
    } else {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.workspace.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      console.log('\nFixture removed.');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
