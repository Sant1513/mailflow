import { requireSuperAdminPage } from '@/lib/auth/adminGuard';
import { PendingFeature } from '@/components/ui/PendingFeature';

export default async function AdminSystemSettingsPage() {
  await requireSuperAdminPage();
  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">System Settings</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Retention policy, rate limits, AI provider configuration.
      </p>
      <PendingFeature title="System Settings" phase="Phase 6-7 (retention policy UI, AI provider config UI)" />
    </div>
  );
}
