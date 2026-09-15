import { prisma } from '@/lib/db/client';
import { ForbiddenError, type AppSession } from '@/lib/auth/session';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { Role } from '@prisma/client';
import { FILE_META_SELECT } from './campaign';
import { parseFields } from './types';

/**
 * Loads a library document and enforces workspace ownership in one place
 * (§94). SUPER_ADMIN may read across workspaces; changes are only ever made
 * from the document's own workspace.
 */
export async function loadDocumentTemplateForSession(session: AppSession, id: string) {
  const template = await prisma.documentTemplate.findUnique({
    where: { id },
    include: {
      file: { select: FILE_META_SELECT },
      owner: { select: { id: true, name: true, email: true } },
    },
  });
  if (!template) return null;
  if (template.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Not your workspace');
  }
  return template;
}

export type LoadedDocumentTemplate = NonNullable<Awaited<ReturnType<typeof loadDocumentTemplateForSession>>>;

export function requireOwnWorkspace(session: AppSession, workspaceId: string) {
  if (workspaceId !== session.workspaceId) {
    throw new ForbiddenError('Documents can only be changed from their own workspace.');
  }
}

/** Whether this session may change a document in the given workspace (never while viewing as). */
export function canEditIn(session: AppSession, workspaceId: string): boolean {
  try {
    requireCanWrite(session);
  } catch {
    return false;
  }
  return workspaceId === session.workspaceId;
}

export function documentPayload(t: LoadedDocumentTemplate) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    name: t.name,
    description: t.description,
    archived: t.archived,
    fileNamePattern: t.fileNamePattern,
    lockMode: t.lockMode,
    stampReference: t.stampReference,
    fields: parseFields(t.fields),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    owner: t.owner,
    file: { id: t.file.id, fileName: t.file.fileName, size: t.file.size, pageCount: t.file.pageCount, sha256: t.file.sha256 },
  };
}
