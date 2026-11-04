import { prisma } from '@/lib/db/client';

/**
 * Names for contacts that have none, from what MailFlow already knows (best source first):
 *   1. the recipient list they came from (the sheet/CSV's name column),
 *   2. the display name on their own replies ("Bhuvan C <cbhuvan08@gmail.com>"),
 *   3. Google "Other contacts" names (read with the profile photos, lib/profilePhotos).
 * Only empty names are filled — a name someone typed or imported is never overwritten.
 */

const NAME_EXACT = /^(full[\s_-]*name|student[\s_-]*name|candidate[\s_-]*name|recruiter[\s_-]*name|contact[\s_-]*name|name)$/i;
const NOT_A_PERSON = /user|file|company|college|school|batch|course|program|org|business|account|template|campaign|domain|host|city|state|father|mother|parent|guardian|manager|first|last/i;

/** The column holding a person's name: "Name"/"Full name"/"Student name" first, never "Username". */
export function pickNameColumn<T extends { key: string; label: string; type?: string }>(columns: T[]): T | null {
  const text = columns.filter((c) => !c.type || c.type === 'TEXT');
  const exact = text.find((c) => NAME_EXACT.test(c.label.trim()) || NAME_EXACT.test(c.key.trim()));
  if (exact) return exact;
  return text.find((c) => /name/i.test(`${c.label} ${c.key}`) && !NOT_A_PERSON.test(`${c.label} ${c.key}`)) ?? null;
}

/** A usable display name, or null: trimmed, no quotes, not an address, sensible length. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!name || name.length < 2 || name.length > 120 || name.includes('@') || /^(null|undefined|n\/?a|-+)$/i.test(name)) return null;
  return name;
}

export interface FillResult {
  fromLists: number;
  fromReplies: number;
  fromGoogle: number;
}

/** Fills empty contact names in an organization (optionally one workspace). Safe to re-run. */
export async function fillMissingNames(opts: { organizationId: string; workspaceId?: string | null; googleNames?: Map<string, string> }): Promise<FillResult> {
  const result: FillResult = { fromLists: 0, fromReplies: 0, fromGoogle: 0 };
  const scope = { organizationId: opts.organizationId, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) };

  // 1. Their recipient list's name column.
  const nameColumnByDataset = new Map<string, string | null>();
  let cursor: string | undefined;
  for (let round = 0; round < 25; round++) {
    const contacts = await prisma.contact.findMany({
      where: { ...scope, name: null },
      select: { id: true, records: { select: { datasetId: true, data: true }, take: 3 } },
      orderBy: { id: 'asc' },
      take: 2000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!contacts.length) break;
    cursor = contacts[contacts.length - 1]!.id;
    const missing = [...new Set(contacts.flatMap((c) => c.records.map((r) => r.datasetId)).filter((d) => !nameColumnByDataset.has(d)))];
    if (missing.length) {
      const cols = await prisma.datasetColumn.findMany({ where: { datasetId: { in: missing } }, select: { datasetId: true, key: true, label: true, type: true }, orderBy: { order: 'asc' } });
      for (const d of missing) nameColumnByDataset.set(d, pickNameColumn(cols.filter((c) => c.datasetId === d))?.key ?? null);
    }
    const ids: string[] = [];
    const names: string[] = [];
    for (const c of contacts) {
      for (const r of c.records) {
        const key = nameColumnByDataset.get(r.datasetId);
        const name = key ? cleanName((r.data as Record<string, unknown>)[key]) : null;
        if (name) {
          ids.push(c.id);
          names.push(name);
          break;
        }
      }
    }
    if (ids.length) result.fromLists += await setNames(ids, names);
    if (contacts.length < 2000) break;
  }

  // 2. The display name on their latest reply.
  result.fromReplies = await prisma.$executeRaw`
    UPDATE "Contact" AS c SET "name" = m.n, "updatedAt" = now()
    FROM (
      SELECT DISTINCT ON (lower(cm."senderEmail")) lower(cm."senderEmail") AS e, btrim(cm."senderName", ' "''') AS n
      FROM "ConversationMessage" cm
      JOIN "Conversation" cv ON cv."id" = cm."conversationId"
      WHERE cv."organizationId" = ${opts.organizationId}
        AND cm."direction" = 'INBOUND'
        AND cm."senderName" IS NOT NULL
        AND length(btrim(cm."senderName", ' "''')) BETWEEN 2 AND 120
        AND position('@' in cm."senderName") = 0
      ORDER BY lower(cm."senderEmail"), cm."sentAt" DESC
    ) AS m
    WHERE c."organizationId" = ${opts.organizationId}
      AND (${opts.workspaceId ?? null}::text IS NULL OR c."workspaceId" = ${opts.workspaceId ?? null})
      AND c."name" IS NULL
      AND lower(c."primaryEmail") = m.e`;

  // 3. Google Other contacts.
  if (opts.googleNames?.size) {
    const entries = [...opts.googleNames.entries()].map(([e, n]) => [e, cleanName(n)] as const).filter((p): p is readonly [string, string] => !!p[1]);
    for (let i = 0; i < entries.length; i += 2000) {
      const chunk = entries.slice(i, i + 2000);
      result.fromGoogle += await prisma.$executeRaw`
        UPDATE "Contact" AS c SET "name" = v.n, "updatedAt" = now()
        FROM unnest(${chunk.map((p) => p[0])}::text[], ${chunk.map((p) => p[1])}::text[]) AS v(e, n)
        WHERE c."organizationId" = ${opts.organizationId}
          AND (${opts.workspaceId ?? null}::text IS NULL OR c."workspaceId" = ${opts.workspaceId ?? null})
          AND c."name" IS NULL
          AND lower(c."primaryEmail") = v.e`;
    }
  }
  return result;
}

async function setNames(ids: string[], names: string[]): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "Contact" AS c SET "name" = v.n, "updatedAt" = now()
    FROM unnest(${ids}::text[], ${names}::text[]) AS v(id, n)
    WHERE c."id" = v.id AND c."name" IS NULL`;
}
