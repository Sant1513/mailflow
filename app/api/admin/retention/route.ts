import { NextResponse } from 'next/server';
import { Role, EmailJobStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import {
  EMPTY_POLICY,
  cutoffFor,
  policyDiff,
  retentionPolicySchema,
  type RetentionPolicyInput,
  type RetentionPreview,
} from '@/lib/retention/policy';

async function currentPolicy(organizationId: string): Promise<RetentionPolicyInput & { updatedAt: Date | null; updatedBy: string | null }> {
  const row = await prisma.retentionPolicy.findUnique({ where: { organizationId } });
  if (!row) return { ...EMPTY_POLICY, updatedAt: null, updatedBy: null };
  const updatedBy = row.updatedById
    ? (await prisma.user.findUnique({ where: { id: row.updatedById }, select: { name: true } }))?.name ?? null
    : null;
  return {
    messageBodyDays: row.messageBodyDays,
    emailJobBodyDays: row.emailJobBodyDays,
    auditLogDays: row.auditLogDays,
    updatedAt: row.updatedAt,
    updatedBy,
  };
}

/** Counts what a policy WOULD touch right now. Read-only — see lib/retention/policy.ts. */
async function preview(organizationId: string, policy: RetentionPolicyInput, now = new Date()): Promise<RetentionPreview> {
  const msgCutoff = cutoffFor(policy.messageBodyDays, now);
  const jobCutoff = cutoffFor(policy.emailJobBodyDays, now);
  const auditCutoff = cutoffFor(policy.auditLogDays, now);

  const [messageBodies, emailJobBodies, auditLogs] = await Promise.all([
    msgCutoff
      ? prisma.conversationMessage.count({
          where: {
            conversation: { organizationId },
            createdAt: { lt: msgCutoff },
            OR: [{ htmlBody: { not: null } }, { plainTextBody: { not: null } }],
          },
        })
      : 0,
    jobCutoff
      ? prisma.emailJob.count({
          where: { campaign: { organizationId }, status: EmailJobStatus.SENT, sentAt: { lt: jobCutoff } },
        })
      : 0,
    auditCutoff ? prisma.auditLog.count({ where: { organizationId, createdAt: { lt: auditCutoff } } }) : 0,
  ]);
  return { messageBodies, emailJobBodies, auditLogs };
}

/** Current policy plus the live impact preview. `?preview=` accepts a draft policy (JSON) to preview before saving. */
export const GET = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const url = new URL(req.url);
  const policy = await currentPolicy(session.organizationId);

  let draft: RetentionPolicyInput | null = null;
  const raw = url.searchParams.get('preview');
  if (raw) draft = retentionPolicySchema.parse(JSON.parse(raw));

  return NextResponse.json({
    policy,
    preview: await preview(session.organizationId, draft ?? policy),
    enforcement: 'none',
  });
});

/** Replace the policy. Audited with a before/after diff (§95). Never deletes anything. */
export const PUT = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  if (session.viewingAs) {
    return NextResponse.json({ error: 'Read-only while viewing another workspace' }, { status: 403 });
  }
  const next = retentionPolicySchema.parse(await req.json());
  const before = await currentPolicy(session.organizationId);

  await prisma.retentionPolicy.upsert({
    where: { organizationId: session.organizationId },
    create: { organizationId: session.organizationId, ...next, updatedById: session.userId },
    update: { ...next, updatedById: session.userId },
  });

  await audit(session, 'RETENTION_POLICY_UPDATE', {
    targetType: 'Organization',
    targetId: session.organizationId,
    metadata: { diff: policyDiff(before, next) },
  });

  return NextResponse.json({
    policy: await currentPolicy(session.organizationId),
    preview: await preview(session.organizationId, next),
    enforcement: 'none',
  });
});
