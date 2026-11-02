import { prisma } from '@/lib/db/client';
import { automatedReason, CLICK_BURST_MS } from '@/lib/email/botDetect';

/**
 * Stores one open or click, flagged as automated when it looks like a machine
 * (lib/email/botDetect.ts). Best effort: tracking never fails the request it rides on.
 */
export async function recordTrackingEvent(input: {
  type: 'OPEN' | 'CLICK';
  campaignId: string;
  emailJobId: string;
  email: string;
  url?: string | null;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  try {
    const at = new Date();
    const job = await prisma.emailJob.findUnique({ where: { id: input.emailJobId }, select: { sentAt: true } });
    let reason = automatedReason({ type: input.type, userAgent: input.userAgent, sentAt: job?.sentAt ?? null, at });

    // A scanner clicks every link in the email within a moment; a person clicks one.
    if (input.type === 'CLICK') {
      const burst = await prisma.emailTrackingEvent.findMany({
        where: {
          emailJobId: input.emailJobId,
          type: 'CLICK',
          createdAt: { gte: new Date(at.getTime() - CLICK_BURST_MS) },
          NOT: { url: input.url ?? undefined },
        },
        select: { id: true },
      });
      if (burst.length) {
        reason = reason ?? 'several links clicked at once';
        await prisma.emailTrackingEvent.updateMany({
          where: { id: { in: burst.map((b) => b.id) } },
          data: { automated: true, automatedReason: 'several links clicked at once' },
        });
      }
    }

    await prisma.emailTrackingEvent.create({
      data: {
        campaignId: input.campaignId,
        emailJobId: input.emailJobId,
        email: input.email,
        type: input.type,
        url: input.url ?? null,
        ip: input.ip,
        userAgent: input.userAgent,
        automated: !!reason,
        automatedReason: reason,
      },
    });
  } catch {
    /* non-critical: tracking events are best effort */
  }
}
