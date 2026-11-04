import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';

/**
 * Profile photos for a list of addresses (components/ui/Avatar.tsx batches its lookups here).
 * POST so addresses never end up in URLs or access logs. Only this organization's photos.
 */
export const dynamic = 'force-dynamic';

const body = z.object({ emails: z.array(z.string().max(320)).max(300) });

export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  const { emails } = body.parse(await req.json());
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];
  if (!wanted.length) return NextResponse.json({ photos: {} });
  const rows = await prisma.profilePhoto.findMany({
    where: { organizationId: session.organizationId, email: { in: wanted } },
    select: { email: true, url: true },
  });
  return NextResponse.json(
    { photos: Object.fromEntries(rows.map((r) => [r.email, r.url])) },
    { headers: { 'cache-control': 'private, max-age=300' } },
  );
});
