import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { lastEmailed } from '@/lib/recruiterSend/recent';
import { emailKey } from '@/lib/recruiterSend/emailKey';
import { coolOffBodySchema, parseCoolOffDate, toLastEmailedInfo } from '@/lib/contacts/recentEmailed';
import { Role } from '@prisma/client';

// §61 recipient timeline: everything about a contact in one chronological
// view — records across datasets, conversations, notes, follow-ups.
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const contact = await prisma.contact.findUnique({
    where: { id: params.id },
    include: {
      records: { include: { dataset: { select: { id: true, name: true } } } },
      conversations: {
        include: { messages: { orderBy: { createdAt: 'asc' } }, notes: true, followUps: true, tags: { include: { tag: true } } },
        orderBy: { lastMessageAt: 'desc' },
      },
      recipientHistory: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (contact.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError();
  }

  const last = await lastEmailed(contact.organizationId, [contact.primaryEmail]);
  return NextResponse.json({ contact, lastEmailed: toLastEmailedInfo(last.get(emailKey(contact.primaryEmail))) });
});

/**
 * Cool-off: { doNotContactUntil: "YYYY-MM-DD" | null, coolOffNote?: string | null }. null clears it (and the note).
 * Same rules as other edits: needs write access (not a viewer, not while viewing another workspace) and the contact must be in
 * the caller's workspace (super admins excepted). Bulk sends skip the person until the date.
 */
export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const contact = await prisma.contact.findUnique({ where: { id: params.id } });
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (contact.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError();
  }

  const body = coolOffBodySchema.parse(await req.json());
  const until = body.doNotContactUntil === null ? null : parseCoolOffDate(body.doNotContactUntil);
  const note = until ? body.coolOffNote?.trim() || null : null;
  const updated = await prisma.contact.update({ where: { id: contact.id }, data: { doNotContactUntil: until, coolOffNote: note } });

  await audit(session, until ? 'CONTACT_COOL_OFF_SET' : 'CONTACT_COOL_OFF_CLEARED', {
    targetType: 'Contact',
    targetId: contact.id,
    metadata: { email: contact.primaryEmail, until: until?.toISOString() ?? null, note, previousUntil: contact.doNotContactUntil?.toISOString() ?? null },
  });

  return NextResponse.json({ contact: { id: updated.id, doNotContactUntil: updated.doNotContactUntil, coolOffNote: updated.coolOffNote } });
});
