import { requireSuperAdminPage } from '@/lib/auth/adminGuard';
import { PendingFeature } from '@/components/ui/PendingFeature';

export default async function AdminConversationsPage() {
  await requireSuperAdminPage();
  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">All Conversations</h1>
      <p className="mb-4 text-sm text-muted-foreground">Organization-wide inbox oversight.</p>
      <PendingFeature title="All Conversations" phase="Phase 5 (Conversations/Inbox)" />
    </div>
  );
}
