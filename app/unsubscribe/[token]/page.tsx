import { decodeUnsubToken } from '@/lib/email/tracking';
import UnsubscribeClient from './UnsubscribeClient';

export default function UnsubscribePage({ params }: { params: { token: string } }) {
  const payload = decodeUnsubToken(params.token);
  const email = payload?.email ?? null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
        <div className="mb-4 text-3xl">📭</div>
        <h1 className="mb-2 text-xl font-semibold">Unsubscribe</h1>
        {email ? (
          <>
            <p className="mb-6 text-sm text-muted-foreground">
              You are unsubscribing <span className="font-medium text-foreground">{email}</span> from
              future emails from this workspace.
            </p>
            <UnsubscribeClient token={params.token} email={email} />
          </>
        ) : (
          <p className="text-sm text-destructive">
            This unsubscribe link is invalid or has expired. Please contact us directly.
          </p>
        )}
      </div>
    </div>
  );
}
