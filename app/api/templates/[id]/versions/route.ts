import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadTemplateForSession, latestVersionOf } from '@/lib/templates/access';
import { extractVariables, htmlToPlainText } from '@/lib/templates/variables';

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const template = await loadTemplateForSession(session, params.id);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ versions: template.versions });
});

const createVersionSchema = z.object({
  subject: z.string().max(500),
  html: z.string(),
  css: z.string().nullable().optional(),
  plainText: z.string().nullable().optional(),
});

/**
 * §21: every meaningful change creates a NEW version. Existing versions are
 * never mutated, because campaigns/batches point at a specific version id
 * and historical emails must always render exactly as they were sent
 * (§89/§126). If the content is byte-identical to the latest version this
 * is a no-op, so repeated saves don't inflate version numbers.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const template = await loadTemplateForSession(session, params.id);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = createVersionSchema.parse(await req.json());
  const latest = latestVersionOf(template.versions);

  // Resolve plainText exactly once, up front. The editor doesn't send one,
  // so it gets auto-generated from the HTML — and the "unchanged?" check
  // below must compare against that generated value, not against null, or
  // every save would look like a change and inflate the version number.
  const effectivePlainText = body.plainText ?? (body.html ? htmlToPlainText(body.html) : null);

  const unchanged =
    latest &&
    latest.subject === body.subject &&
    latest.html === body.html &&
    (latest.css ?? null) === (body.css ?? null) &&
    (latest.plainText ?? null) === effectivePlainText;

  if (unchanged) {
    return NextResponse.json({ version: latest, created: false, message: 'No changes since the latest version.' });
  }

  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: (latest?.version ?? 0) + 1,
      subject: body.subject,
      html: body.html,
      css: body.css ?? null,
      plainText: effectivePlainText,
      variables: extractVariables(body.subject, body.html, effectivePlainText),
      createdById: session.userId,
    },
  });

  await prisma.template.update({ where: { id: template.id }, data: { updatedAt: new Date() } });

  await audit(session, 'TEMPLATE_VERSION_CREATE', {
    targetType: 'TemplateVersion',
    targetId: version.id,
    metadata: { templateId: template.id, version: version.version },
  });

  return NextResponse.json({ version, created: true }, { status: 201 });
});
