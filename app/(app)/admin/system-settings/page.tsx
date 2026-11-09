import { requireSuperAdminPage } from '@/lib/auth/adminGuard';
import { getOptionalSession } from '@/lib/auth/session';
import { PageHeader } from '@/components/ui/PageHeader';
import { SettingsLayout, type SettingsSection } from '@/components/settings/SettingsLayout';
import { allowedDomain } from '@/lib/auth/options';
import { RetentionPanel } from '@/components/admin/RetentionPanel';
import { SlackSettings } from '@/components/admin/SlackSettings';
import { AutomationSettings } from '@/components/admin/AutomationSettings';
import { aiStatus } from '@/lib/ai/service';
import { startOfTodayIst } from '@/lib/ai/limits';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const SECTIONS: SettingsSection[] = [
  { id: 'retention', label: 'Data retention', icon: 'retention', group: 'Organisation' },
  { id: 'automation', label: 'Reports & triage', icon: 'automation', group: 'Organisation' },
  { id: 'slack', label: 'Slack', icon: 'slack', group: 'Organisation' },
  { id: 'runtime', label: 'Runtime', icon: 'runtime', group: 'Deployment' },
];

export default async function AdminSystemSettingsPage() {
  await requireSuperAdminPage();
  const session = await getOptionalSession();
  const readOnly = Boolean(session?.viewingAs);

  const domain = allowedDomain();
  const rateLimit = process.env.EMAIL_RATE_LIMIT_PER_MINUTE ?? '';
  const ai = aiStatus();
  const aiConfigured = ai.configured;
  const since = startOfTodayIst();
  const [aiCallsToday, aiFailedToday] = await Promise.all([
    prisma.aiUsage.count({ where: { organizationId: session!.organizationId, createdAt: { gte: since }, OR: [{ errorReason: null }, { errorReason: { notIn: ['LIMIT', 'DISABLED', 'NOT_CONFIGURED'] } }] } }),
    prisma.aiUsage.count({ where: { organizationId: session!.organizationId, createdAt: { gte: since }, success: false } }),
  ]);

  const runtime = [
    { label: 'Sign-in restriction', value: domain ? `@${domain} only` : 'Open — any Google account', env: 'ALLOWED_EMAIL_DOMAIN' },
    { label: 'Send rate limit', value: rateLimit ? `${rateLimit} emails / minute / mailbox` : 'Default', env: 'EMAIL_RATE_LIMIT_PER_MINUTE' },
    { label: 'AI provider', value: aiConfigured ? `Gemini · ${ai.model}${ai.fallbackModels.length ? ` (falls back to ${ai.fallbackModels.join(', ')})` : ''}` : 'Not configured', env: 'GEMINI_API_KEY / GEMINI_MODEL / GEMINI_FALLBACK_MODELS' },
    { label: 'AI enabled', value: ai.enabled ? (aiConfigured ? 'On' : 'On, but no key — features hidden') : 'Off (AI_ENABLED=false)', env: 'AI_ENABLED' },
    { label: 'AI daily limits', value: `${ai.limits.userDaily} per user · ${ai.limits.orgDaily} per organisation`, env: 'AI_USER_DAILY_LIMIT / AI_ORG_DAILY_LIMIT' },
    { label: 'AI usage today (org)', value: `${aiCallsToday} / ${ai.limits.orgDaily} requests · ${aiFailedToday} failed or refused`, env: 'AiUsage table' },
  ];

  return (
    <div className="p-4 sm:p-6">
      <PageHeader eyebrow="Super Admin" title="System Settings" description="Reports, AI triage, Slack, data retention and the deployment's runtime configuration, for the whole organisation." />
      <SettingsLayout sections={SECTIONS}>

      <section id="retention" className="panel scroll-mt-6 p-5">
        <div className="mb-4">
          <h2 className="font-heading text-base font-semibold">Data retention</h2>
          <p className="text-xs text-muted-foreground">§130 — per-organization policy, audited on every change.</p>
        </div>
        <RetentionPanel readOnly={readOnly} />
      </section>

      <section id="automation" className="panel scroll-mt-6 p-5">
        <div className="mb-4">
          <h2 className="font-heading text-base font-semibold">Automation</h2>
          <p className="text-xs text-muted-foreground">Daily report (8 PM IST, Mon–Fri), weekly report and AI inbox triage for the whole organisation.</p>
        </div>
        <AutomationSettings readOnly={readOnly} />
      </section>

      <section id="slack" className="panel scroll-mt-6 p-5">
        <div className="mb-4">
          <h2 className="font-heading text-base font-semibold">Slack notifications</h2>
          <p className="text-xs text-muted-foreground">Assignments, resolutions and follow-ups post to one channel and continue in threads. People are mentioned by the Slack ID on their profile.</p>
        </div>
        <SlackSettings readOnly={readOnly} />
      </section>

      <section id="runtime" className="panel scroll-mt-6 p-5">
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
      </SettingsLayout>
    </div>
  );
}
