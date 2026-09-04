import { PendingFeature } from '@/components/ui/PendingFeature';

export default function HistoryPage() {
  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">History</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Full, immutable record of every outbound and inbound message.
      </p>
      <PendingFeature title="History" phase="Phase 3-5 (email sending + inbound sync must exist first for there to be history)" />
    </div>
  );
}
