import { redirect } from 'next/navigation';
import { getOptionalSession } from '@/lib/auth/session';
import { PendingSignOut } from './PendingSignOut';

export default async function PendingPage() {
  const session = await getOptionalSession();

  // Already approved — send them to the app.
  if (session && session.status === 'ACTIVE') redirect('/');
  // Not signed in — send them to login.
  if (!session) redirect('/login');

  const adminEmail = process.env.ADMIN_CONTACT_EMAIL ?? 'admin@masaischool.com';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <div className="mb-6 text-5xl">⏳</div>
      <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
        Account pending approval
      </h1>
      <p className="mt-3 max-w-md text-sm text-muted-foreground">
        Your account (<strong>{session.email}</strong>) has been created and is waiting for a super
        admin to approve it. You will be able to access MailFlow once approved.
      </p>

      <div className="mt-6 rounded-lg border border-border bg-card px-6 py-5 text-left text-sm">
        <p className="font-medium text-foreground">To speed up access, reach out to:</p>
        <a
          href={`mailto:${adminEmail}?subject=MailFlow%20access%20request&body=Hi%2C%20I%20just%20registered%20with%20${encodeURIComponent(session.email)}%20and%20need%20approval%20to%20access%20MailFlow.`}
          className="mt-2 block font-mono text-primary hover:underline"
        >
          {adminEmail}
        </a>
        <p className="mt-3 text-xs text-muted-foreground">
          Admins can approve your account under{' '}
          <span className="font-medium text-foreground">Approvals → User Registrations</span>.
        </p>
      </div>

      <PendingSignOut />
    </div>
  );
}
