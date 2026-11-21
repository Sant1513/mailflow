/**
 * QA of the bounce scan (lib/email/bounceScan.ts) with the real notice reader and rules on throwaway data: a send that bounced is
 * found and suppressed, scanning the same notice again changes nothing, a bounce on an email sent outside MailFlow is suppressed,
 * a delay is only noted, a mailbox that cannot be read shows its error, and the cron route and status line work. Nothing is sent
 * and Gmail is never contacted (a fake mailbox hands over the notices).
 *
 * Usage: BASE_URL=http://localhost:3021 npx tsx scripts/qa-bounce-scan.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';
import { runBounceScan, scanStatus, defaultDeps } from '../lib/email/bounceScan';
import { fixture, rawToGmail } from '../tests/fixtures/ndr/mime';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3021';
const COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass++; console.log(`  PASS ${name}`); } else { fail++; failures.push(name); console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); }
}

const stamp = Date.now();
const DOMAIN = `qbn-${stamp}.test`;
const BOX = `box-${stamp}@${DOMAIN}`;
const BOX2 = `broken-${stamp}@${DOMAIN}`;
const victim = `qbn-victim-${stamp}@example.org`;
const outsider = `qbn-outsider-${stamp}@example.org`;
const delayed = `qbn-delay-${stamp}@example.org`;
let orgId = '';

/** The postfix "user unknown" fixture, re-addressed to our throwaway mailbox and a chosen failed recipient. */
function userUnknown(failed: string, id: string) {
  const raw = fixture('postfix-user-unknown.eml')
    .replace(/placements@masaischool\.com/g, BOX)
    .replace(/rohit\.verma@example\.org/g, failed)
    .replace(/<20261112053320\.0BB4911C0A9@mail\.example\.org>/g, `<${id}@mail.example.org>`)
    .replace(/<job-4411@masaischool\.com>/g, `<job-${id}@${DOMAIN}>`);
  return rawToGmail(raw, { id, threadId: `th-${id}`, internalDate: String(Date.now() - 60_000) });
}
function delay(failed: string, id: string) {
  const raw = fixture('gmail-delay.eml').replace(/[\w.+-]+@[\w-]+\.(com|org|in)/g, (m) => (/gmail|google|mailer|googlemail/i.test(m) ? m : m));
  return rawToGmail(raw.replace(/placements@masaischool\.com/g, BOX), { id, threadId: `th-${id}`, internalDate: String(Date.now() - 60_000) });
}

async function main() {
  console.log(`=== Bounce scan QA against ${BASE_URL} ===\n`);
  const org = await prisma.organization.create({ data: { name: `QBN ${stamp}`, allowedDomain: DOMAIN } });
  orgId = org.id;
  const admin = await prisma.user.create({ data: { organizationId: org.id, googleId: `qbn-${stamp}`, email: `qbn+${stamp}@${DOMAIN}`, name: 'QBN admin', role: Role.ADMIN } });
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: `QBN ws ${stamp}` } });
  const mk = (emailAddress: string, extra: Record<string, unknown> = {}) => prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: admin.id, emailAddress, displayName: 'qa', status: 'CONNECTED', refreshTokenEnc: 'not-a-real-token', ...extra } });
  const acct = await mk(BOX);
  // One mailbox per person and workspace: two more people for the broken and the disconnected mailbox.
  const other = async (tag: string) => {
    const u = await prisma.user.create({ data: { organizationId: org.id, googleId: `qbn-${tag}-${stamp}`, email: `qbn-${tag}+${stamp}@${DOMAIN}`, name: `QBN ${tag}`, role: Role.ADMIN } });
    const w = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: u.id, name: `QBN ${tag} ${stamp}` } });
    return { u, w };
  };
  const o2 = await other('b');
  const o3 = await other('c');
  const broken = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: o2.w.id, userId: o2.u.id, emailAddress: BOX2, displayName: 'qa2', status: 'CONNECTED', refreshTokenEnc: 'not-a-real-token' } });
  await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: o3.w.id, userId: o3.u.id, emailAddress: `gone-${stamp}@${DOMAIN}`, displayName: 'gone', status: 'DISCONNECTED' } });

  // A recruiter send from the mailbox that went to `victim` (sent a minute ago).
  const blast = await prisma.recruiterBlast.create({ data: { organizationId: org.id, workspaceId: ws.id, createdById: admin.id, name: 'QBN send', subject: 'Your Masai interview slot', mode: 'INDIVIDUAL', status: 'COMPLETED', html: '<p>x</p>', plainText: 'x', body: 'x', accountIds: [acct.id], gapSeconds: 3 } });
  const group = await prisma.recruiterBlastGroup.create({ data: { blastId: blast.id, seq: 1, status: 'SENT', recipientCount: 1, accountId: acct.id, fromEmail: BOX, sentAt: new Date(Date.now() - 120_000), messageIdHeader: `<job-n1-${stamp}@${DOMAIN}>`, gmailThreadId: `th-sent-${stamp}` } });
  await prisma.recruiterBlastRecipient.create({ data: { blastId: blast.id, email: victim, status: 'SENT', sentAt: new Date(Date.now() - 120_000), groupId: group.id } });

  // A fake mailbox: Gmail is never contacted.
  const mailbox: Record<string, any[]> = { [BOX]: [userUnknown(victim, 'n1'), userUnknown(outsider, 'n2'), delay(delayed, 'n3')] };
  const fake = {
    reader: (a: any) => ({
      search: async () => { if (a.emailAddress === BOX2) throw new Error('invalid_grant: Token has been expired or revoked.'); return (mailbox[a.emailAddress] ?? []).map((m) => ({ id: m.id })); },
      get: async (id: string) => (mailbox[a.emailAddress] ?? []).find((m) => m.id === id) ?? null,
    }),
    process: defaultDeps.process,
  };

  console.log('Scanning');
  const s1 = await runBounceScan({ deps: fake, budgetMs: 60_000 }).then((s) => ({ ...s, mine: s.mailboxes.filter((m) => m.email.endsWith(DOMAIN)) }));
  const m1 = s1.mine.find((m) => m.email === BOX)!;
  check('the mailbox was scanned: 3 notices read, none failed', m1?.ok && m1.notices === 3 && m1.errors === 0, m1);
  const supp = (email: string) => prisma.emailSuppression.findMany({ where: { email, workspaceId: ws.id }, select: { reason: true, category: true, source: true, detail: true, recruiterBlastId: true } });
  const sv = await supp(victim);
  check('the bounced recruiter is on the suppression list as a hard bounce (address does not exist), tied to the send', sv.length === 1 && sv[0]!.reason === 'BOUNCED' && sv[0]!.category === 'USER_UNKNOWN' && sv[0]!.recruiterBlastId === blast.id, sv);
  check('…and the send shows that recruiter as bounced', (await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: blast.id, email: victim }, select: { status: true } }))?.status === 'BOUNCED');
  const so = await supp(outsider);
  check('a bounce on an email sent outside MailFlow is suppressed too (a hard bounce, tied to no send)', so.length === 1 && so[0]!.reason === 'BOUNCED' && so[0]!.category === 'USER_UNKNOWN' && so[0]!.recruiterBlastId === null, so);
  check('a delay notice is noted only, nothing suppressed', (await supp(delayed)).length === 0 && m1.noted >= 1, { noted: m1.noted });
  const row1 = await prisma.emailProviderAccount.findUnique({ where: { id: acct.id }, select: { bounceScanAt: true, bounceScanError: true, bounceScanNotices: true } });
  check('the mailbox remembers how far it has read', !!row1?.bounceScanAt && Date.now() - row1.bounceScanAt.getTime() < 60_000 && row1.bounceScanError === null && row1.bounceScanNotices === 3, row1);

  console.log('\nScanning again (the same notices come back through the 2-hour overlap)');
  const before = await prisma.emailSuppression.count({ where: { workspaceId: ws.id } });
  const s2 = await runBounceScan({ deps: fake, budgetMs: 60_000, onlyMailbox: BOX });
  const after = await prisma.emailSuppression.count({ where: { workspaceId: ws.id } });
  check('re-reading the same notices adds no duplicates', s2.mailboxes[0]?.ok === true && before === after, { before, after });
  check('…and the soft-bounce note is not counted twice', (await prisma.softBounce.count({ where: { email: delayed } })) <= 1);

  console.log('\nA mailbox that cannot be read');
  const bs = await prisma.emailProviderAccount.findUnique({ where: { id: broken.id }, select: { bounceScanError: true, bounceScanAt: true } });
  const brokenResult = s1.mine.find((m) => m.email === BOX2);
  check('its failure is recorded and it did not stop the other mailbox', brokenResult?.ok === false && /invalid_grant/.test(bs?.bounceScanError ?? '') && bs?.bounceScanAt === null, { brokenResult, bs });
  const st = await scanStatus(org.id);
  check('the status names the failing mailbox and the disconnected one that cannot be checked', st.failing.some((f) => f.email === BOX2) && st.unreadable.some((u) => u.status === 'DISCONNECTED') && st.connected === 2 && st.fresh === 1, st);

  console.log('\nThe cron route and the status line');
  const secret = process.env.CRON_SECRET;
  const noAuth = await fetch(`${BASE_URL}/api/cron/bounce-scan`);
  check('the cron route refuses a call without the secret (401)', noAuth.status === 401, noAuth.status);
  if (secret) {
    const r = await fetch(`${BASE_URL}/api/cron/bounce-scan?mailbox=${encodeURIComponent(BOX)}`, { headers: { Authorization: `Bearer ${secret}` } });
    const j: any = await r.json().catch(() => ({}));
    check('with the secret it runs; a mailbox with a bad token reports its error instead of crashing (no Gmail is contacted)', r.status === 200 && j.mailboxes?.length === 1 && j.mailboxes[0].ok === false, { s: r.status, j });
  }
  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken: token, userId: admin.id, expires: new Date(Date.now() + 3600_000) } });
  const status = await fetch(`${BASE_URL}/api/suppressions/scan-status`, { headers: { Cookie: `${COOKIE}=${token}` } });
  const sj: any = await status.json().catch(() => ({}));
  check('the status endpoint answers for a signed-in person', status.status === 200 && sj.connected === 2 && Array.isArray(sj.failing) && Array.isArray(sj.unreadable), { s: status.status, sj });
  check('…and is closed to anyone signed out', (await fetch(`${BASE_URL}/api/suppressions/scan-status`)).status === 401);

  if (process.env.SHOT_FILE) {
    (await import('node:fs')).writeFileSync(process.env.SHOT_FILE, JSON.stringify({ cookie: `${COOKIE}=${token}` }));
    await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 120_000)));
  }
}

main()
  .catch((err) => { fail++; failures.push(`script crashed: ${err instanceof Error ? err.message : String(err)}`); console.error(err); })
  .finally(async () => {
    if (orgId) {
      const ws = (await prisma.workspace.findMany({ where: { organizationId: orgId }, select: { id: true } })).map((w) => w.id);
      const blasts = (await prisma.recruiterBlast.findMany({ where: { organizationId: orgId }, select: { id: true } })).map((b) => b.id);
      await prisma.recruiterBlastRecipient.deleteMany({ where: { blastId: { in: blasts } } }).catch(() => undefined);
      await prisma.recruiterBlastGroup.deleteMany({ where: { blastId: { in: blasts } } }).catch(() => undefined);
      await prisma.recruiterBlast.deleteMany({ where: { id: { in: blasts } } }).catch(() => undefined);
      await prisma.emailSuppression.deleteMany({ where: { workspaceId: { in: ws } } }).catch(() => undefined);
      await prisma.softBounce.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      const users = (await prisma.user.findMany({ where: { organizationId: orgId }, select: { id: true } })).map((u) => u.id);
      await prisma.session.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
      await prisma.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.emailProviderAccount.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.workspace.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id: orgId } }).catch((e) => console.error('cleanup failed (remove org', orgId, 'by hand):', e.message));
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
