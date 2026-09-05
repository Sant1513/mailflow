import { requireSuperAdminPage } from '@/lib/auth/adminGuard';
import { getOptionalSession } from '@/lib/auth/session';
import { allowedDomain } from '@/lib/auth/options';
import { RetentionPanel } from '@/components/admin/RetentionPanel';

export const dynamic = 'force-dynamic';

export default async function AdminSystemSettingsPage() {
  await requireSuperAdminPage();
  const session = await getOptionalSession();
  const readOnly = Boolean(session?.viewingAs);

  const domain = allowedDomain();
  const rateLimit = process.env.EMAIL_RATE_LIMIT_PER_MINUTE ?? '';
  const aiConfigured = Boolean(process.env.GEMINI_API_KEY);

  const runtime = [
    { label: 'Sign-in restriction', value: domain ? `@${domain} only` : 'Open — any Google account', env: 'ALLOWED_EMAIL_DOMAIN' },
    { label: 'Send rate limit', value: rateLimit ? `${rateLimit} emails / minute / mailbox` : 'Default', env: 'EMAIL_RATE_LIMIT_PER_MINUTE' },
    { label: 'AI provider', value: aiConfigured ? 'Gemini key present' : 'Not configured (Phase 7)', env: 'GEMINI_API_KEY' },
  ];

  return (
    <div className="p-6">
      <div className="eyebrow mb-2">Super Admin</div>
      <h1 className="font-heading text-2xl font-bold tracking-tight">System Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">Retention policy and the deployment&apos;s runtime configuration.</p>

      <section className="panel mt-6 max-w-3xl p-5">
        <div className="mb-4">
          <h2 className="font-heading text-base font-semibold">Data retention</h2>
          <p className="text-xs text-muted-foreground">§130 — per-organization policy, audited on every change.</p>
        </div>
        <RetentionPanel readOnly={readOnly} />
      </section>

      <section className="panel mt-4 max-w-3xl p-5">
        <h2 className="font-heading text-base font-semibold">Runtime configuration</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Read from the environment at deploy time. Change these in the hosting provider, not here — so a change is
          always a deliberate, reviewed deployment.
        </p>
        <dl className="divide-y divide-border-subtle">
          {runtime.map((r) => (
            <div key={r.env} className="grid gap-1 py-2.5 sm:grid-cols-[1fr_1.4fr]">
              <dt className="text-sm">
                {r.label}
                <div className="font-mono text-[11px] text-faint">{r.env}</div>
              </dt>
              <dd className="text-sm text-muted-foreground">{r.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
