import { PrismaClient, type SystemState } from '@prisma/client';
import { prisma } from '@/lib/db/client';

/**
 * Server switch: MailFlow runs either on the cloud (Vercel + Supabase, the default) or on
 * the laptop (laptop-server/). Only one of them accepts changes at a time; the other is a
 * standby copy. The switch itself is one row in the cloud database (SystemState), read by
 * the front door (middleware.ts → /api/system/state), the Server page, and the laptop server.
 *
 * A handover (switchTo set) shows a short "switching servers" page everywhere while the
 * laptop copies the active database to the other one, then flips activeServer. The laptop
 * does both directions of the copy (laptop-server/start.mjs), so nothing is ever written on
 * both sides at once.
 */

export type ServerName = 'cloud' | 'laptop';

/** The laptop counts as online if its heartbeat is this recent. */
export const LAPTOP_ONLINE_MS = 2 * 60_000;
/** While the laptop is active and silent this long, MailFlow moves to the cloud on its own. */
export const LAPTOP_SILENT_MS = 10 * 60_000;
/** A switch to the laptop that hasn't finished in this time is cancelled (MailFlow stays on the cloud). */
export const SWITCH_TO_LAPTOP_TIMEOUT_MS = 5 * 60_000;
/** A switch to the cloud the laptop hasn't finished in this time is completed without the laptop. */
export const SWITCH_TO_CLOUD_TIMEOUT_MS = 10 * 60_000;

const globalForControl = globalThis as unknown as { controlDb?: PrismaClient };

/**
 * The database holding the switch: always the cloud one. On Vercel that is the app's own
 * database; the laptop's copy of the app reaches it through CONTROL_DATABASE_URL.
 */
export function controlDb(): PrismaClient {
  const url = process.env.CONTROL_DATABASE_URL;
  if (!url) return prisma;
  return (globalForControl.controlDb ??= new PrismaClient({ datasources: { db: { url } } }));
}

type StateFields = Pick<SystemState, 'activeServer' | 'switchTo' | 'switchStartedAt' | 'lastLaptopSeenAt' | 'lastSyncAt'>;

const fmt = (d: Date | null | undefined) =>
  d ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : 'never';

/**
 * The automatic safety moves, as a pure function of the state and the time. Returns the
 * fields to change, or null when nothing needs to happen.
 */
export function autoTransition(s: StateFields, now: Date): Partial<SystemState> | null {
  const t = now.getTime();
  const silentFor = s.lastLaptopSeenAt ? t - s.lastLaptopSeenAt.getTime() : Infinity;
  const switchAge = s.switchStartedAt ? t - s.switchStartedAt.getTime() : 0;
  const lastCopy = `Changes made on the laptop after the last copy (${fmt(s.lastSyncAt)}) are kept in the laptop's backups.`;

  if (s.switchTo === 'laptop' && switchAge > SWITCH_TO_LAPTOP_TIMEOUT_MS) {
    return {
      switchTo: null,
      switchStartedAt: null,
      note: 'The switch to the laptop was cancelled: the laptop did not finish within 5 minutes. MailFlow stayed on the cloud, nothing was lost.',
    };
  }
  if (s.switchTo === 'cloud' && switchAge > SWITCH_TO_CLOUD_TIMEOUT_MS && silentFor > LAPTOP_ONLINE_MS) {
    return {
      activeServer: 'cloud',
      switchTo: null,
      switchStartedAt: null,
      note: `Moved to the cloud without the laptop: it stopped answering during the switch. ${lastCopy}`,
    };
  }
  if (s.activeServer === 'laptop' && !s.switchTo && silentFor > LAPTOP_SILENT_MS) {
    return {
      activeServer: 'cloud',
      note: `Moved to the cloud automatically: the laptop has been silent since ${fmt(s.lastLaptopSeenAt)}. ${lastCopy}`,
    };
  }
  return null;
}

/** Reads the switch, creating it on first use. */
export async function readState(): Promise<SystemState> {
  // A plain read: the row exists after the first use, and an upsert is a write on every call
  // (the front door asks on every cache miss). Created only when missing.
  const row = await controlDb().systemState.findUnique({ where: { id: 'main' } });
  return row ?? controlDb().systemState.upsert({ where: { id: 'main' }, create: { id: 'main' }, update: {} });
}

/** Reads the switch and applies any automatic move that is due (only one caller wins). */
export async function currentState(now = new Date()): Promise<SystemState> {
  const s = await readState();
  const change = autoTransition(s, now);
  if (!change) return s;
  // Conditional on the row being unchanged, so two requests can't both apply it.
  await controlDb().systemState.updateMany({ where: { id: 'main', updatedAt: s.updatedAt }, data: change });
  return readState();
}

export function laptopOnline(s: Pick<SystemState, 'lastLaptopSeenAt'>, now = new Date()): boolean {
  return !!s.lastLaptopSeenAt && now.getTime() - s.lastLaptopSeenAt.getTime() <= LAPTOP_ONLINE_MS;
}
