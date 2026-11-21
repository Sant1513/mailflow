/**
 * Fixture for the loading-screen browser check: a throwaway organization with one admin and a session, written to
 * SHOT_FILE as { cookie }; held open for HOLD_MS, then removed. Nothing is sent. Uses the laptop standby database.
 *
 * Usage: SHOT_FILE=<path> HOLD_MS=300000 npx tsx scripts/qa-loading-screen.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Role } from '@prisma/client';
import { prisma } from '../lib/db/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3021';
const COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
const stamp = Date.now();
const DOMAIN = `qls-${stamp}.test`;

async function main() {
  const org = await prisma.organization.create({ data: { name: `QLS ${stamp}`, allowedDomain: DOMAIN } });
  try {
    const admin = await prisma.user.create({ data: { organizationId: org.id, googleId: `qls-${stamp}`, email: `qls+${stamp}@${DOMAIN}`, name: 'QLS admin', role: Role.ADMIN } });
    await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: `QLS ws ${stamp}` } });
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken, userId: admin.id, expires: new Date(Date.now() + 3600_000) } });
    fs.writeFileSync(process.env.SHOT_FILE!, JSON.stringify({ cookie: `${COOKIE}=${sessionToken}` }));
    await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 300_000)));
  } finally {
    const users = (await prisma.user.findMany({ where: { organizationId: org.id }, select: { id: true } })).map((u) => u.id);
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.auditLog.deleteMany({ where: { organizationId: org.id } });
    await prisma.workspace.deleteMany({ where: { organizationId: org.id } });
    await prisma.user.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
