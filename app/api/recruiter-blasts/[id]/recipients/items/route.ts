import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { loadBlast, requireBlastAdmin } from '@/lib/recruiterSend/access';
import { emailKey } from '@/lib/recruiterSend/emailKey';
import { forgetPlan } from '@/lib/recruiterSend/plan';
import { buildRow, cleanDomains, domainsWhere, splitDuplicates, MAX_RECIPIENTS, MAX_ROWS_PER_ADD, MAX_UNDO } from '@/lib/recruiterSend/listEdit';

/**
 * Hand edits of a DRAFT's recruiter list (Preview list): add recruiters, change one, delete some or all that match a search.
 * Deleted rows are returned so the page can offer "Undo" (which adds them back). A follow-up's list comes from its audience
 * choice, so there only deleting is allowed.
 */
export const dynamic = 'force-dynamic';

async function draftOf(id: string, session: Awaited<ReturnType<typeof requireBlastAdmin>>) {
  const blast = await loadBlast(session, id);
  if (!blast) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }), blast: null };
  if (blast.status !== 'DRAFT') return { res: NextResponse.json({ error: 'Only a draft can change its recruiters.' }, { status: 409 }), blast: null };
  return { res: null, blast };
}

/** Keys (mailflow_email_key) among `keys` that are already in this send. */
async function takenKeys(blastId: string, keys: string[], exceptId?: string): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const found = await prisma.$queryRaw<{ key: string }[]>(
    Prisma.sql`SELECT mailflow_email_key("email") AS key FROM "RecruiterBlastRecipient" WHERE "blastId" = ${blastId} ${exceptId ? Prisma.sql`AND "id" <> ${exceptId}` : Prisma.empty} AND mailflow_email_key("email") = ANY(${keys}::text[])`,
  );
  return new Set(found.map((f) => f.key));
}

const rowSchema = z.object({ email: z.string().max(320), name: z.string().max(200).nullish(), data: z.record(z.unknown()).optional() });

const addSchema = z.object({ rows: z.array(rowSchema).min(1).max(MAX_ROWS_PER_ADD) });

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const g = await draftOf(params.id, session);
  if (!g.blast) return g.res!;
  const { blast } = g;
  if (blast.parentBlastId) return NextResponse.json({ error: 'A follow-up takes its recruiters from the audience you chose; you can delete some but not add.' }, { status: 409 });
  const { rows } = addSchema.parse(await req.json());

  const built: { email: string; name: string | null; data: Record<string, string> | null }[] = [];
  const invalid: { email: string; reason: string }[] = [];
  for (const r of rows) {
    const b = buildRow(r, blast.columns ?? [], blast.emailColumn ?? null);
    if ('error' in b) invalid.push({ email: r.email.slice(0, 120), reason: b.error });
    else built.push(b);
  }
  const existing = await prisma.recruiterBlastRecipient.count({ where: { blastId: blast.id } });
  const taken = await takenKeys(blast.id, [...new Set(built.map((b) => emailKey(b.email)))]);
  const { fresh, duplicates } = splitDuplicates(built, taken);
  if (existing + fresh.length > MAX_RECIPIENTS) return NextResponse.json({ error: `One send takes up to ${MAX_RECIPIENTS.toLocaleString()} recruiters.` }, { status: 400 });

  const created = fresh.length
    ? await prisma.$transaction(fresh.map((r) => prisma.recruiterBlastRecipient.create({
        data: { blastId: blast.id, email: r.email, name: r.name, data: r.data ? (r.data as Prisma.InputJsonValue) : Prisma.JsonNull },
        select: { id: true, email: true, name: true, status: true, data: true },
      })))
    : [];
  if (created.length) {
    forgetPlan(blast.id);
    await audit(session, 'RECRUITER_SEND_LIST_EDIT', { targetType: 'RecruiterBlast', targetId: blast.id, metadata: { action: 'add', count: created.length, sample: created.slice(0, 10).map((c) => c.email) } });
  }
  return NextResponse.json({
    added: created.length,
    duplicates: duplicates.map((d) => d.email),
    invalid,
    rows: created,
  });
});

const patchSchema = z.object({ id: z.string().min(1), email: z.string().max(320).optional(), name: z.string().max(200).nullish(), data: z.record(z.unknown()).optional() });

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const g = await draftOf(params.id, session);
  if (!g.blast) return g.res!;
  const { blast } = g;
  if (blast.parentBlastId) return NextResponse.json({ error: "A follow-up's recruiters can be deleted but not edited." }, { status: 409 });
  const body = patchSchema.parse(await req.json());
  const current = await prisma.recruiterBlastRecipient.findFirst({ where: { id: body.id, blastId: blast.id }, select: { id: true, email: true, name: true, data: true, status: true } });
  if (!current) return NextResponse.json({ error: 'That recruiter is no longer in the list.' }, { status: 404 });

  const columns = blast.columns ?? [];
  const oldData = current.data && typeof current.data === 'object' && !Array.isArray(current.data) ? (current.data as Record<string, unknown>) : {};
  const built = buildRow({ email: body.email ?? current.email, name: body.name ?? current.name, data: { ...oldData, ...(body.data ?? {}) } }, columns, blast.emailColumn ?? null);
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 });
  if (emailKey(built.email) !== emailKey(current.email) && (await takenKeys(blast.id, [emailKey(built.email)], current.id)).size) {
    return NextResponse.json({ error: `${built.email} is already in this list.` }, { status: 409 });
  }
  const row = await prisma.recruiterBlastRecipient.update({
    where: { id: current.id },
    data: { email: built.email, name: built.name, data: built.data ? (built.data as Prisma.InputJsonValue) : Prisma.JsonNull },
    select: { id: true, email: true, name: true, status: true, data: true },
  });
  forgetPlan(blast.id);
  await audit(session, 'RECRUITER_SEND_LIST_EDIT', { targetType: 'RecruiterBlast', targetId: blast.id, metadata: { action: 'edit', from: current.email, to: row.email } });
  return NextResponse.json({ row });
});

const deleteSchema = z.union([
  z.object({ ids: z.array(z.string().min(1)).min(1).max(20_000) }),
  z.object({ all: z.literal(true), q: z.string().max(200).optional(), domains: z.array(z.string().max(255)).max(200).optional() }),
]);

export const DELETE = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const g = await draftOf(params.id, session);
  if (!g.blast) return g.res!;
  const { blast } = g;
  const scope = deleteSchema.parse(await req.json());
  const q = 'all' in scope ? (scope.q ?? '').trim() : '';
  const domains = 'all' in scope ? cleanDomains(scope.domains) : [];
  const where: Prisma.RecruiterBlastRecipientWhereInput =
    'ids' in scope
      ? { blastId: blast.id, id: { in: scope.ids } }
      : {
          blastId: blast.id,
          AND: [
            ...(q ? [{ OR: [{ email: { contains: q, mode: 'insensitive' as const } }, { name: { contains: q, mode: 'insensitive' as const } }] }] : []),
            ...(domains.length ? [domainsWhere(domains)] : []),
          ],
        };

  const count = await prisma.recruiterBlastRecipient.count({ where });
  // Hand the rows back for Undo when it is a reasonable number.
  const undo = count > 0 && count <= MAX_UNDO
    ? await prisma.recruiterBlastRecipient.findMany({ where, orderBy: { id: 'asc' }, select: { email: true, name: true, data: true } })
    : null;
  const deleted = count ? (await prisma.recruiterBlastRecipient.deleteMany({ where })).count : 0;
  if (deleted) {
    forgetPlan(blast.id);
    await audit(session, 'RECRUITER_SEND_LIST_EDIT', { targetType: 'RecruiterBlast', targetId: blast.id, metadata: { action: 'delete', count: deleted, by: 'ids' in scope ? 'ticked' : [q ? `search "${q}"` : '', domains.length ? `domains ${domains.slice(0, 10).join(', ')}` : ''].filter(Boolean).join(' + ') || 'all', sample: (undo ?? []).slice(0, 10).map((u) => u.email) } });
  }
  const remaining = await prisma.recruiterBlastRecipient.count({ where: { blastId: blast.id } });
  return NextResponse.json({
    deleted,
    remaining,
    undo: undo ? undo.map((u) => ({ email: u.email, name: u.name, data: u.data && typeof u.data === 'object' && !Array.isArray(u.data) ? u.data : undefined })) : null,
  });
});
