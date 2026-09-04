import { PendingFeature } from '@/components/ui/PendingFeature';

export default function AutomationsPage() {
  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">Automations</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Airtable-style trigger → condition → action builder.
      </p>
      <PendingFeature
        title="Automations"
        phase="Phase 4 (triggers, conditions, actions, stop conditions, versioning, run log)"
      />
    </div>
  );
}
