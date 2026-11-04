import { MailboxUsage } from '@/components/admin/MailboxUsage';

/** Admins: emails sent from each person's mailbox today, against Google's daily limits. */
export default function MailboxUsagePage() {
  return (
    <div className="max-w-5xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Mailbox usage</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        How much each person&apos;s Gmail has sent in the last 24 hours — campaigns and recruiter bulk sends together, the way Google counts
        them — so nobody&apos;s mailbox goes over its limit.
      </p>
      <section className="rounded-lg border bg-card p-4">
        <MailboxUsage />
      </section>
    </div>
  );
}
