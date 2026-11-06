import { people as peopleApi } from '@googleapis/people';
import { randomBytes } from 'node:crypto';
import type { EmailProviderAccount } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { authorizedClientFor, hasScope, PHOTOS_OAUTH_SCOPE } from '@/lib/gmail/oauth';
import { fillMissingNames } from '@/lib/contacts/names';

/**
 * Profile photos of the people we email, from each connected mailbox's Google "Other contacts"
 * (Google adds everyone the mailbox has emailed or heard from). Only photos the person made
 * visible are kept; Google's generated letter avatars (photo.default) are skipped, and the UI
 * shows initials for those. Read-only, opt-in per mailbox (Settings → Gmail → Profile photos),
 * refreshed weekly by the gmail-sync schedule.
 */
export const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 20; // up to 20,000 contacts per mailbox per run

export interface PhotoSyncResult {
  account: string;
  contacts: number;
  photos: number;
  /** Contacts that got a name from Google (only empty names are filled). */
  names?: number;
  error?: string;
}

/** A Google profile photo URL at a small, sharp size (the URL's "=s100" suffix sets the size). */
export function sizedPhoto(url: string, px = 96): string {
  return /=s\d+(-c)?$/.test(url) ? url.replace(/=s\d+(-c)?$/, `=s${px}-c`) : url;
}

/** Plain-language reason for the usual failures (People API off, permission not granted). */
function explain(err: unknown): string {
  const e = err as { code?: number; message?: string; errors?: { reason?: string }[] };
  const msg = String(e.message ?? err);
  if (/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(msg)) {
    return 'The Google People API is not enabled in the Google Cloud project yet (APIs & Services → Library → People API → Enable).';
  }
  if (e.code === 403 || /insufficient|PERMISSION_DENIED/i.test(msg)) return 'This mailbox has not allowed profile photos yet (Settings → Gmail → Turn on profile photos).';
  if (e.code === 401 || /invalid_grant/i.test(msg)) return 'The mailbox needs reconnecting in Settings.';
  return msg.slice(0, 300);
}

/** Reads one mailbox's Other contacts and saves the real photos for its organization. */
export async function syncProfilePhotos(account: EmailProviderAccount): Promise<PhotoSyncResult> {
  const result: PhotoSyncResult = { account: account.emailAddress, contacts: 0, photos: 0 };
  if (!hasScope(account, PHOTOS_OAUTH_SCOPE)) return { ...result, error: 'Profile photos are not allowed for this mailbox.' };
  try {
    const people = peopleApi({ version: 'v1', auth: await authorizedClientFor(account) });
    const found = new Map<string, string>();
    const names = new Map<string, string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      // READ_SOURCE_TYPE_PROFILE adds each person's Google profile: without it Other contacts only
      // carry Google's letter placeholders (all 8,296 were default on the first mailbox tried).
      const res = await people.otherContacts.list({
        readMask: 'emailAddresses,names,photos',
        pageSize: 1000,
        pageToken,
        sources: ['READ_SOURCE_TYPE_CONTACT', 'READ_SOURCE_TYPE_PROFILE'],
      });
      for (const person of res.data.otherContacts ?? []) {
        result.contacts += 1;
        const display = person.names?.find((n) => n.displayName)?.displayName;
        if (display) for (const e of person.emailAddresses ?? []) if (e.value) names.set(e.value.trim().toLowerCase(), display);
        const photo = (person.photos ?? []).find((p) => p.url && !p.default);
        if (!photo?.url) continue;
        for (const e of person.emailAddresses ?? []) {
          const email = e.value?.trim().toLowerCase();
          if (email && email.includes('@')) found.set(email, sizedPhoto(photo.url));
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    await savePhotos(account.organizationId, account.id, found);
    result.photos = found.size;
    // Their names too, for contacts that have none (lib/contacts/names.ts).
    const filled = await fillMissingNames({ organizationId: account.organizationId, googleNames: names }).catch(() => null);
    if (filled) result.names = filled.fromGoogle;
    await prisma.emailProviderAccount.update({ where: { id: account.id }, data: { photosSyncedAt: new Date() } });
    return result;
  } catch (err) {
    // Try again at the next scheduled run rather than every few minutes.
    await prisma.emailProviderAccount.update({ where: { id: account.id }, data: { photosSyncedAt: new Date() } }).catch(() => undefined);
    const reason = explain(err);
    console.error(`[photos] ${account.emailAddress}: ${reason}`);
    return { ...result, error: reason };
  }
}

/** Upserts many photos in a few statements (one per 1,000). */
async function savePhotos(organizationId: string, accountId: string, photos: Map<string, string>): Promise<void> {
  const entries = [...photos.entries()];
  for (let i = 0; i < entries.length; i += 1000) {
    const chunk = entries.slice(i, i + 1000);
    const ids = chunk.map(() => `pp${randomBytes(12).toString('hex')}`);
    const emails = chunk.map(([e]) => e);
    const urls = chunk.map(([, u]) => u);
    await prisma.$executeRaw`
      INSERT INTO "ProfilePhoto" ("id", "organizationId", "email", "url", "accountId", "checkedAt")
      SELECT id, ${organizationId}, email, url, ${accountId}, now()
      FROM unnest(${ids}::text[], ${emails}::text[], ${urls}::text[]) AS t(id, email, url)
      ON CONFLICT ("organizationId", "email") DO UPDATE SET "url" = EXCLUDED."url", "accountId" = EXCLUDED."accountId", "checkedAt" = now()`;
  }
}

/** The scheduled refresh: mailboxes that allowed photos and haven't been read for a week. */
export async function refreshDuePhotos(budgetMs: number): Promise<PhotoSyncResult[]> {
  const deadline = Date.now() + budgetMs;
  const due = await prisma.emailProviderAccount.findMany({
    where: {
      status: 'CONNECTED',
      refreshTokenEnc: { not: null },
      scope: { contains: PHOTOS_OAUTH_SCOPE },
      OR: [{ photosSyncedAt: null }, { photosSyncedAt: { lt: new Date(Date.now() - REFRESH_EVERY_MS) } }],
    },
    take: 5,
  });
  const results: PhotoSyncResult[] = [];
  for (const account of due) {
    if (Date.now() > deadline) break;
    results.push(await syncProfilePhotos(account));
  }
  return results;
}
