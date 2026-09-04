import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { PendingFeature } from '@/components/ui/PendingFeature';

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  const user = session!.user as any;

  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-semibold">Settings</h1>

      <section className="mb-8 max-w-lg rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Profile</h2>
        <div className="text-sm">
          <div><span className="text-muted-foreground">Name:</span> {user.name}</div>
          <div><span className="text-muted-foreground">Email:</span> {user.email}</div>
          <div><span className="text-muted-foreground">Role:</span> {user.role}</div>
        </div>
      </section>

      <section className="max-w-lg rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Gmail</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Connect your @masaischool.com Gmail so campaigns send from your real address — never a
          shared &quot;noreply@&quot; sender.
        </p>
        <PendingFeature
          title="Gmail connection"
          phase="Phase 3 (Gmail OAuth — lib/gmail/oauth.ts)"
          note="Will request incremental gmail.send / gmail.readonly scopes, separate from login."
        />
      </section>
    </div>
  );
}
