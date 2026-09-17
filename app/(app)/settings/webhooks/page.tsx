import { WebhooksManager } from '@/components/settings/WebhooksManager';

export default function WebhooksSettingsPage() {
  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">Outbound Webhooks</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Register HTTPS endpoints to receive real-time POST notifications when key events happen in your workspace.
        Each request is signed with HMAC-SHA256 — verify the{' '}
        <code className="rounded bg-muted px-1 text-xs">X-MailFlow-Signature</code> header to confirm authenticity.
      </p>
      <div className="max-w-2xl rounded-lg border bg-card p-4">
        <WebhooksManager />
      </div>
    </div>
  );
}
