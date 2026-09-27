import { NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailProvider as EmailProviderEnum, Role, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { getOrgSettings, orgSettingsSchema, updateOrgSettings, TRIAGE_INTENTS } from '@/lib/settings/org';
import { collectNeedsAttention, digestTotal, renderDigestEmail } from '@/lib/digest/needsAttention';
import { buildWeeklyReport, renderWeeklyReportEmail } from '@/lib/reports/weekly';
import { dispatchDigest, dispatchWeeklyReport } from '@/lib/digest/dispatch';

/**
 * Super Admin → System Settings → Automation: daily digest, weekly report and
 * AI inbox triage. GET returns settings plus the choices the form needs;
 * PUT saves a partial update; POST previews or sends a test to the caller.
 */

async function context(organizationId: string) {
  const [settings, mailboxes, users] = await Promise.all([
    getOrgSettings(organizationId),
    prisma.emailProviderAccount.findMany({
      where: { organizationId, provider: EmailProviderEnum.GMAIL, status: 'CONNECTED' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, emailAddress: true, user: { select: { name: true } } },
    }),
    prisma.user.findMany({
      where: { organizationId, status: UserStatus.ACTIVE },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, role: true },
    }),
  ]);
  return {
    settings,
    mailboxes: mailboxes.map((m) => ({ id: m.id, emailAddress: m.emailAddress, ownerName: m.user?.name ?? null })),
    users,
    intents: TRIAGE_INTENTS,
  };
}

export const GET = withErrorHandling(async () => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  return NextResponse.json(await context(session.organizationId));
});

// Every field optional: the form sends only what changed. Internal markers are never writable.
const putSchema = orgSettingsSchema.omit({ lastDigestOn: true, lastWeeklyReportOn: true }).deepPartial();

export const PUT = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  if (session.viewingAs) return NextResponse.json({ error: 'Read-only while viewing another workspace' }, { status: 403 });
  const body = putSchema.parse(await req.json());
  if (body.senderAccountId) {
    const ok = await prisma.emailProviderAccount.count({ where: { id: body.senderAccountId, organizationId: session.organizationId } });
    if (!ok) return NextResponse.json({ error: 'That mailbox is not in this organisation' }, { status: 400 });
  }
  if (body.triage?.assignByIntent) {
    const ids = Object.values(body.triage.assignByIntent).filter((v): v is string => !!v);
    const found = ids.length ? await prisma.user.count({ where: { id: { in: ids }, organizationId: session.organizationId } }) : 0;
    if (found !== new Set(ids).size) return NextResponse.json({ error: 'An assignee is not in this organisation' }, { status: 400 });
  }
  await updateOrgSettings(session.organizationId, body, session.userId);
  await audit(session, 'AUTOMATION_SETTINGS_UPDATE', { targetType: 'Organization', targetId: session.organizationId, metadata: { sections: Object.keys(body) } });
  return NextResponse.json(await context(session.organizationId));
});

const postSchema = z.object({
  action: z.enum(['preview-digest', 'preview-report', 'test-digest', 'test-report']),
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const { action } = postSchema.parse(await req.json());
  const orgId = session.organizationId;

  if (action === 'preview-digest') {
    const settings = await getOrgSettings(orgId);
    const data = await collectNeedsAttention(orgId, settings.digest);
    return NextResponse.json({ items: digestTotal(data), ...renderDigestEmail(data) });
  }
  if (action === 'preview-report') {
    return NextResponse.json(renderWeeklyReportEmail(await buildWeeklyReport(orgId)));
  }

  const result = action === 'test-digest'
    ? await dispatchDigest(orgId, { testTo: session.email })
    : await dispatchWeeklyReport(orgId, { testTo: session.email });
  await audit(session, action === 'test-digest' ? 'DIGEST_TEST_SENT' : 'WEEKLY_REPORT_TEST_SENT', {
    targetType: 'Organization',
    targetId: orgId,
    metadata: { email: result.email },
  });
  return NextResponse.json({ ok: !!result.email?.startsWith('SENT'), outcome: result.email });
});
