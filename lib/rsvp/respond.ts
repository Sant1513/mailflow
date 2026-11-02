import { ColumnType } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { ensureColumns, updateRecordFields } from '@/lib/records/systemUpdate';
import { isClosed, readRsvpConfig, type RsvpConfig, type RsvpOption } from '@/lib/rsvp/config';
import type { TrackingPayload } from '@/lib/email/tracking';

/**
 * Recording an RSVP answer. Rules, in order: the campaign must still have RSVP on; the
 * deadline must not have passed; a changed answer needs "allow changes"; a seat-limited
 * option must still have room (people already holding that answer keep their seat).
 * The answer can be written to a column on the recipient's data row (with change history).
 */

export type RsvpOutcome =
  | { status: 'recorded' | 'unchanged'; option: RsvpOption; previous: RsvpOption | null }
  | { status: 'closed' | 'full' | 'locked'; option: RsvpOption | null; current: RsvpOption | null }
  | { status: 'invalid' };

export interface RsvpContext {
  config: RsvpConfig;
  campaign: { id: string; name: string; workspaceId: string; createdById: string; datasetId: string };
  current: { answer: string; note: string | null } | null;
}

export function columnKeyFor(label: string): string {
  const key = label.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'RSVP';
  return /^[0-9]/.test(key) ? `col_${key}` : key;
}

export async function loadRsvpContext(payload: TrackingPayload): Promise<RsvpContext | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: payload.campaignId },
    select: { id: true, name: true, workspaceId: true, createdById: true, datasetId: true, rsvp: true },
  });
  const config = readRsvpConfig(campaign?.rsvp);
  if (!campaign || !config) return null;
  const current = await prisma.rsvpResponse.findUnique({
    where: { campaignId_email: { campaignId: campaign.id, email: payload.email.toLowerCase() } },
    select: { answer: true, note: true },
  });
  return { config, campaign, current };
}

export async function recordRsvp(
  ctx: RsvpContext,
  payload: TrackingPayload,
  input: { answer: string; note?: string | null; ip: string | null; userAgent: string | null },
): Promise<RsvpOutcome> {
  const { config, campaign } = ctx;
  const option = config.options.find((o) => o.key === input.answer);
  if (!option) return { status: 'invalid' };
  const currentOption = ctx.current ? config.options.find((o) => o.key === ctx.current!.answer) ?? null : null;
  const email = payload.email.toLowerCase();

  if (isClosed(config)) return { status: 'closed', option, current: currentOption };

  const sameAnswer = ctx.current?.answer === option.key;
  const note = input.note?.trim() ? input.note.trim().slice(0, 2000) : null;
  if (ctx.current && !sameAnswer && !config.allowChange) return { status: 'locked', option, current: currentOption };
  if (sameAnswer && (note === null || note === ctx.current?.note)) return { status: 'unchanged', option, previous: currentOption };

  if (option.capacity && !sameAnswer) {
    const taken = await prisma.rsvpResponse.count({ where: { campaignId: campaign.id, answer: option.key } });
    if (taken >= option.capacity) return { status: 'full', option, current: currentOption };
  }

  const job = await prisma.emailJob.findUnique({ where: { id: payload.emailJobId }, select: { recordId: true } });
  await prisma.rsvpResponse.upsert({
    where: { campaignId_email: { campaignId: campaign.id, email } },
    create: {
      campaignId: campaign.id, emailJobId: payload.emailJobId, recordId: job?.recordId ?? null, email, answer: option.key,
      note, ip: input.ip, userAgent: input.userAgent?.slice(0, 500) ?? null,
    },
    update: {
      answer: option.key, ...(note !== null ? { note } : {}), changes: { increment: sameAnswer ? 0 : 1 },
      ip: input.ip, userAgent: input.userAgent?.slice(0, 500) ?? null,
    },
  });

  // Write the answer onto the recipient's row (and a note column when there is a note).
  if (config.saveToColumn && job?.recordId) {
    const key = columnKeyFor(config.saveToColumn);
    const noteKey = `${key}_note`;
    await ensureColumns(campaign.datasetId, [
      { key, label: config.saveToColumn, type: ColumnType.TEXT },
      ...(note ? [{ key: noteKey, label: `${config.saveToColumn} note`, type: ColumnType.TEXT }] : []),
    ]);
    await updateRecordFields({
      recordId: job.recordId,
      fields: { [key]: option.label, ...(note ? { [noteKey]: note } : {}) },
      reason: `RSVP to "${campaign.name}"`,
    }).catch(() => undefined);
  }

  if (config.notifyOwner && !sameAnswer) {
    await prisma.notification
      .create({
        data: {
          workspaceId: campaign.workspaceId,
          userId: campaign.createdById,
          type: 'RSVP',
          title: `${email} answered "${option.label}"`,
          body: `${campaign.name}${note ? ` — "${note.slice(0, 160)}"` : ''}`,
          link: `/campaigns/${campaign.id}?tab=rsvp`,
        },
      })
      .catch(() => undefined);
  }

  // Reaching here means something changed: a new/different answer, or a new note on the same one.
  return { status: 'recorded', option, previous: currentOption };
}
