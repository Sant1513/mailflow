import { Role, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { reminderDue } from '@/lib/orgs/lifecycle';

/**
 * Renewal reminders for the Super Admins (docs/org-lifecycle.md): an in-app notification once at 30, 14, 7, 3, 1 days left and on the
 * day an organisation ends, so a renewal is chased before the customer is locked. Each threshold is sent once: the organisation
 * remembers the last one in lastReminderDays (activating or changing the end date resets it). Safe to call as often as you like.
 */
export interface ReminderRun {
  /** Organisations that got a reminder this run. */
  reminded: { orgUnitId: string; name: string; days: number }[];
  notifications: number;
}

export async function sendRenewalReminders(organizationId: string, now: Date = new Date()): Promise<ReminderRun> {
  const out: ReminderRun = { reminded: [], notifications: 0 };
  const orgs = await prisma.orgUnit.findMany({
    where: { organizationId, status: 'ACTIVE', validUntil: { not: null } },
    select: { id: true, name: true, status: true, validUntil: true, graceDays: true, lastReminderDays: true },
  });
  const due = orgs.map((o) => ({ o, days: reminderDue(o, now) })).filter((x): x is { o: (typeof orgs)[number]; days: number } => x.days !== null);
  if (!due.length) return out;

  // Each Super Admin's notification lives in their own workspace (notifications are per workspace and user).
  const admins = await prisma.user.findMany({
    where: { organizationId, role: Role.SUPER_ADMIN, status: UserStatus.ACTIVE },
    select: { id: true, ownedWorkspaces: { select: { id: true }, take: 1 } },
  });
  const recipients = admins.filter((a) => a.ownedWorkspaces[0]);

  for (const { o, days } of due) {
    const when = days === 0 ? 'ends today' : days === 1 ? 'ends tomorrow' : `ends in ${days} days`;
    const data = recipients.map((a) => ({
      userId: a.id,
      workspaceId: a.ownedWorkspaces[0]!.id,
      type: 'ORG_RENEWAL',
      title: `${o.name} ${when}`,
      body: `Access for ${o.name} is valid until ${o.validUntil!.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}. Record the payment and extend it under Admin → Organisations.`,
      link: '/admin/organisations',
    }));
    if (data.length) {
      const r = await prisma.notification.createMany({ data });
      out.notifications += r.count;
    }
    // Remembered even with nobody to tell, so a later Super Admin is not flooded with old thresholds.
    await prisma.orgUnit.update({ where: { id: o.id }, data: { lastReminderDays: days } });
    out.reminded.push({ orgUnitId: o.id, name: o.name, days });
  }
  return out;
}
