import { MailboxUsage } from '@/components/admin/MailboxUsage';
import { PageHeader } from '@/components/ui/PageHeader';

/** Admins: emails sent from each person's mailbox today, against Google's daily limits. */
export default function MailboxUsagePage() {
  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        eyebrow="Admin"
        title="Mailbox usage"
        description="How much each person's Gmail has sent in the last 24 hours (campaigns, Quick Sends and recruiter bulk sends together, the way Google counts them), so nobody's mailbox goes over its limit."
      />
      <section className="panel overflow-hidden p-0">
        <MailboxUsage />
      </section>
    </div>
  );
}
