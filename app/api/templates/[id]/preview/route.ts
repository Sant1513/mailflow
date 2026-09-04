import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { loadTemplateForSession, latestVersionOf } from '@/lib/templates/access';
import { renderTemplate } from '@/lib/templates/variables';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';
import { Role } from '@prisma/client';

const previewSchema = z.object({
  // Preview against a real record ("Preview as: Rahul Sharma", §25) …
  recordId: z.string().optional(),
  // … or against ad-hoc values / unsaved editor content.
  data: z.record(z.any()).optional(),
  versionId: z.string().optional(),
  draft: z
    .object({
      subject: z.string(),
      html: z.string(),
      css: z.string().nullable().optional(),
      plainText: z.string().nullable().optional(),
    })
    .optional(),
});

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const template = await loadTemplateForSession(session, params.id);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = previewSchema.parse(await req.json());

  // Which content to render: an unsaved draft from the editor, a specific
  // historical version, or the latest saved version.
  let source: { subject: string; html: string; css?: string | null; plainText?: string | null } | null = null;
  if (body.draft) {
    source = body.draft;
  } else if (body.versionId) {
    const v = template.versions.find((x) => x.id === body.versionId);
    if (!v) return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    source = v;
  } else {
    source = latestVersionOf(template.versions);
  }
  if (!source) return NextResponse.json({ error: 'Template has no content yet' }, { status: 400 });

  // Resolve the data to personalize with.
  let data: Record<string, unknown> = body.data ?? {};
  let recordLabel: string | null = null;
  if (body.recordId) {
    const record = await prisma.record.findUnique({
      where: { id: body.recordId },
      include: { dataset: true },
    });
    if (!record) return NextResponse.json({ error: 'Record not found' }, { status: 404 });
    if (record.dataset.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenError();
    }
    data = record.data as Record<string, unknown>;
    const firstValue = Object.values(data).find((v) => typeof v === 'string' && v.trim());
    recordLabel = typeof firstValue === 'string' ? firstValue : record.id;
  }

  const rendered = renderTemplate(
    { subject: source.subject, html: source.html, plainText: source.plainText },
    data
  );

  // Inline the template's CSS into the preview document, then sanitize the
  // whole thing — the client renders this inside a sandboxed iframe (§23).
  const withCss = source.css ? `<style>${source.css}</style>${rendered.html}` : rendered.html;

  return NextResponse.json({
    subject: rendered.subject,
    html: sanitizeEmailHtml(withCss),
    plainText: rendered.plainText,
    missingVariables: rendered.missingVariables,
    resolved: rendered.resolved,
    recordLabel,
  });
});
