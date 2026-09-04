import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { loadTemplateForSession, latestVersionOf } from '@/lib/templates/access';
import { runHealthCheck } from '@/lib/templates/healthCheck';
import { ColumnType, Role } from '@prisma/client';

const healthSchema = z.object({
  datasetId: z.string().optional(),
  draft: z
    .object({
      subject: z.string(),
      html: z.string(),
      plainText: z.string().nullable().optional(),
    })
    .optional(),
});

/** §27 Email Health Check, run from the template editor or campaign setup. */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const template = await loadTemplateForSession(session, params.id);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = healthSchema.parse(await req.json().catch(() => ({})));
  const source = body.draft ?? latestVersionOf(template.versions);
  if (!source) return NextResponse.json({ error: 'Template has no content yet' }, { status: 400 });

  let availableKeys: string[] | undefined;
  let hasRecipientColumn: boolean | undefined;
  if (body.datasetId) {
    const dataset = await prisma.dataset.findUnique({
      where: { id: body.datasetId },
      include: { columns: true },
    });
    if (!dataset) return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    if (dataset.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenError();
    }
    availableKeys = dataset.columns.map((c) => c.key);
    hasRecipientColumn = dataset.columns.some((c) => c.type === ColumnType.EMAIL);
  }

  // A connected sending account is required before a real send (§28-29).
  const senderAccount = await prisma.emailProviderAccount.findFirst({
    where: { userId: session.userId, workspaceId: session.workspaceId ?? undefined, status: 'CONNECTED' },
  });

  const result = runHealthCheck({
    template: { subject: source.subject, html: source.html, plainText: source.plainText },
    availableKeys,
    hasRecipientColumn,
    senderConnected: !!senderAccount,
    senderEmail: senderAccount?.emailAddress ?? null,
  });

  return NextResponse.json(result);
});
