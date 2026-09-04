import { PendingFeature } from '@/components/ui/PendingFeature';

export default function CampaignsPage() {
  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">Campaigns</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Dry run, approval, batching, and sending from your connected Gmail account.
      </p>
      <PendingFeature
        title="Campaigns"
        phase="Phase 3 (Gmail OAuth, campaigns, dry run, approval, batches, queue)"
        note="Database schema for Campaign/Batch/EmailJob is already in place — see prisma/schema.prisma."
      />
    </div>
  );
}
