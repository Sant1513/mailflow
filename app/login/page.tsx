import { LoginButton } from './LoginButton';
import { allowedDomain } from '@/lib/auth/options';

export default function LoginPage() {
  // Read on the server so the copy always matches the actual policy rather
  // than promising a restriction that is not enforced.
  const restriction = allowedDomain();

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm rounded-lg border bg-card p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">MailFlow</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Email campaigns, automations and conversations in one place.
        </p>
        <LoginButton />
        <p className="mt-4 text-xs text-muted-foreground">
          {restriction
            ? `Only @${restriction} accounts can sign in.`
            : 'Sign in with any Google account.'}
        </p>
      </div>
    </div>
  );
}
