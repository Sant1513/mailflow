import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { fillMissingNames } from '@/lib/contacts/names';

/**
 * Contacts → "Fill missing names": names for this workspace's contacts that have none, from
 * their recipient lists and their own replies (lib/contacts/names.ts). Google names are added
 * by the profile-photo refresh. Never overwrites a name.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = withErrorHandling(async () => {
  const session = await requireSession();
  requireCanWrite(session);
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace on your account.' }, { status: 400 });
  const result = await fillMissingNames({ organizationId: session.organizationId, workspaceId: session.workspaceId });
  await audit(session, 'CONTACT_NAMES_FILLED', { metadata: { ...result } });
  return NextResponse.json({ ...result, total: result.fromLists + result.fromReplies + result.fromGoogle });
});
