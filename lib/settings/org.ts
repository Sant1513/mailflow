import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { parseOrgSettings, type OrgSettings } from '@/lib/settings/org-schema';

export * from '@/lib/settings/org-schema';

/** Server-side read/write of IntegrationSettings.settings (see org-schema.ts). */
export async function getOrgSettings(organizationId: string): Promise<OrgSettings> {
  const row = await prisma.integrationSettings.findUnique({ where: { organizationId }, select: { settings: true } });
  return parseOrgSettings(row?.settings);
}

/** Deep-merges a partial update into the stored settings and returns the result. */
export async function updateOrgSettings(
  organizationId: string,
  patch: DeepPartial<OrgSettings>,
  updatedById: string,
): Promise<OrgSettings> {
  const current = await getOrgSettings(organizationId);
  const next = parseOrgSettings(deepMerge(current, patch));
  const json = next as unknown as Prisma.InputJsonValue;
  await prisma.integrationSettings.upsert({
    where: { organizationId },
    update: { settings: json, updatedById },
    create: { organizationId, settings: json, updatedById },
  });
  return next;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K] };

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev)
        ? deepMerge(prev, v)
        : v;
  }
  return out as T;
}
