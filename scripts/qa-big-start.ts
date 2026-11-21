/**
 * Starts (scheduled a year ahead, nothing is sent) a recruiter send of ~11,900 recruiters with ~560 skipped, like a real big send,
 * and reports how long the check and Start take and what comes back. Throwaway fixtures, removed at the end.
 * Usage: BASE_URL=http://localhost:3021 npx tsx scripts/qa-big-start.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3021';
const COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
const stamp = Date.now();
const DOMAIN = `qbs-${stamp}.test`;
const N = Number(process.env.N ?? 11_900);

async function call(method: string, path: string, cookie: string, body?: unknown) {
  const t = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, { method, headers: { Cookie: cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }).catch((e) => ({ status: 0, text: async () => String(e) }) as any);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status as number, json, text: text.slice(0, 300), ms: Date.now() - t };
}

async function main() {
  const org = await prisma.organization.create({ data: { name: `QBS ${stamp}`, allowedDomain: DOMAIN } });
  try {
    const admin = await prisma.user.create({ data: { organizationId: org.id, googleId: `qbs-${stamp}`, email: `qbs+${stamp}@${DOMAIN}`, name: 'QBS', role: Role.ADMIN } });
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: `QBS ws ${stamp}` } });
    const acct = await prisma.emailProviderAccount.create({ data: { organizationId: org.id, workspaceId: ws.id, userId: admin.id, emailAddress: `box-${stamp}@${DOMAIN}`, displayName: 'box', status: 'CONNECTED' } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: admin.id, expires: new Date(Date.now() + 3600_000) } });
    const cookie = `${COOKIE}=${token}`;
    const blast = await prisma.recruiterBlast.create({ data: { organizationId: org.id, workspaceId: ws.id, createdById: admin.id, name: 'QBS big', subject: 'Big send', mode: 'INDIVIDUAL', html: '<p>Hello</p>', plainText: 'Hello', body: 'Hello', accountIds: [acct.id], gapSeconds: 3 } });
    // ~5% are skipped for static reasons (a typo'd domain), the rest are ordinary Gmail addresses; ~137 were "unsubscribed".
    const emails = Array.from({ length: N }, (_, i) => (i % 21 === 0 ? `typo${i}+${stamp}@gmial.com` : `q${i}x${stamp}@gmail.com`));
    for (let i = 0; i < emails.length; i += 2000) await prisma.recruiterBlastRecipient.createMany({ data: emails.slice(i, i + 2000).map((email) => ({ blastId: blast.id, email })) });
    await prisma.emailSuppression.createMany({ data: emails.filter((_, i) => i % 87 === 1).slice(0, 137).map((email) => ({ workspaceId: ws.id, email, reason: 'UNSUBSCRIBED', source: 'qa' } as any)), skipDuplicates: true }).catch((e) => console.log('suppression fixture skipped:', e.message.split('\n').pop()));

    const chk = await call('POST', `/api/recruiter-blasts/${blast.id}/check`, cookie, {});
    console.log(`check: HTTP ${chk.status} in ${chk.ms} ms; eligible ${chk.json?.eligible} of ${chk.json?.total}; skipped`, JSON.stringify(chk.json?.skippedByReason));
    const start = await call('POST', `/api/recruiter-blasts/${blast.id}/start`, cookie, { scheduledAt: new Date(Date.now() + 365 * 86_400_000).toISOString() });
    console.log(`start: HTTP ${start.status} in ${start.ms} ms;`, start.status === 200 ? JSON.stringify(start.json) : start.text);
    const counts = await prisma.recruiterBlastRecipient.groupBy({ by: ['status'], where: { blastId: blast.id }, _count: true });
    console.log('recipients by status:', JSON.stringify(counts.map((c) => [c.status, c._count])));
  } finally {
    const blasts = (await prisma.recruiterBlast.findMany({ where: { organizationId: org.id }, select: { id: true } })).map((b) => b.id);
    await prisma.recruiterBlastRecipient.deleteMany({ where: { blastId: { in: blasts } } });
    await prisma.recruiterBlastGroup.deleteMany({ where: { blastId: { in: blasts } } });
    await prisma.recruiterBlast.deleteMany({ where: { id: { in: blasts } } });
    const ws = (await prisma.workspace.findMany({ where: { organizationId: org.id }, select: { id: true } })).map((w) => w.id);
    await prisma.emailSuppression.deleteMany({ where: { workspaceId: { in: ws } } }).catch(() => undefined);
    const users = (await prisma.user.findMany({ where: { organizationId: org.id }, select: { id: true } })).map((u) => u.id);
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.auditLog.deleteMany({ where: { organizationId: org.id } });
    await prisma.emailProviderAccount.deleteMany({ where: { organizationId: org.id } });
    await prisma.workspace.deleteMany({ where: { organizationId: org.id } });
    await prisma.user.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
