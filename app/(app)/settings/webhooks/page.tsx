import { WebhooksManager } from '@/components/settings/WebhooksManager';

export default function WebhooksSettingsPage() {
  return (
    <div className="p-4 sm:p-6">
      <h1 className="mb-1 font-heading text-2xl font-bold tracking-tight">Outbound Webhooks</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted-foreground">
        Register HTTPS endpoints to receive real-time POST notifications when key events happen in your workspace.
        Each request is signed with HMAC-SHA256 — verify the{' '}
        <code className="rounded bg-muted px-1 text-xs">X-MailFlow-Signature</code> header to confirm authenticity.
      </p>
      <div className="rounded-lg border bg-card p-4">
        <WebhooksManager />
      </div>
    </div>
  );
}
