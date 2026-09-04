import { PendingFeature } from '@/components/ui/PendingFeature';

export default function InboxPage() {
  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">Inbox</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Unified conversation view across Gmail replies.
      </p>
      <PendingFeature
        title="Inbox"
        phase="Phase 5 (Gmail threading, inbound sync, conversations)"
        note="Requires Gmail OAuth connection (Phase 3) and Pub/Sub inbound sync (Phase 5) — see ARCHITECTURE.md §6-8."
      />
    </div>
  );
}
