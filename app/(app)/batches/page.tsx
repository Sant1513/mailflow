import { PendingFeature } from '@/components/ui/PendingFeature';

export default function BatchesPage() {
  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">Batches</h1>
      <p className="mb-4 text-sm text-muted-foreground">Queue progress, retries, pause/resume/cancel.</p>
      <PendingFeature title="Batches" phase="Phase 3 (Redis + BullMQ queue, workers/email-worker.ts)" />
    </div>
  );
}
