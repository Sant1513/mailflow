'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { ExplainButton } from '@/components/ai/ExplainButton';
import { SenderSettings } from '@/components/campaign/SenderSettings';
import { CampaignReview, type CampaignPreview } from '@/components/campaign/CampaignReview';

interface Simulation {
  total: number;
  wouldSend: number;
  skipped: number;
  invalid: number;
  byReason: Record<string, number>;
  evaluations: {
    recordId: string;
    willSend: boolean;
    email: string | null;
    skipReason: string | null;
    reasonDetail: string;
    sendReason: string | null;
  }[];
  truncated: boolean;
}

const REASON_LABELS: Record<string, string> = {
  ALREADY_SENT: 'Already sent',
  INVALID_EMAIL: 'Invalid email',
  MISSING_EMAIL: 'No email address',
  MISSING_VARIABLE: 'Missing variable value',
  DUPLICATE_IN_BATCH: 'Duplicate address',
  CONDITION_NOT_MET: 'Automation condition not met',
  FREQUENCY_LIMIT: 'Send-frequency limit',
  MANUALLY_SKIPPED: 'Manually excluded',
};

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [validation, setValidation] = useState<any>(null);
  const [batch, setBatch] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${params.id}`);
    if (!res.ok) {
      toast.error('Failed to load campaign');
      return;
    }
    setData(await res.json());
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  const campaign = data?.campaign;
  const latestBatch = campaign?.batches?.[0];

  const loadBatch = useCallback(async () => {
    if (!latestBatch) return;
    const res = await fetch(`/api/batches/${latestBatch.id}`);
    if (res.ok) setBatch(await res.json());
  }, [latestBatch]);

  useEffect(() => {
    loadBatch();
  }, [loadBatch]);

  const loadPreview = useCallback(
    async (recordId?: string) => {
      setPreviewLoading(true);
      const res = await fetch(`/api/campaigns/${params.id}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recordId ? { recordId } : {}),
      });
      setPreviewLoading(false);
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? 'Could not build the preview');
        return;
      }
      setPreview(json);
    },
    [params.id]
  );

  // The review is the point of this screen, so load it up front rather than
  // making the operator ask for it before sending.
  useEffect(() => {
    if (data) loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.campaign?.id]);

  async function runSimulation() {
    setBusy('simulate');
    const res = await fetch(`/api/campaigns/${params.id}/simulate`, { method: 'POST' });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Simulation failed');
      return;
    }
    setSimulation(json.simulation);
    setValidation(json.validation);
    toast.success(`Simulation complete — ${json.simulation.wouldSend} would send. No emails were sent.`);
  }

  async function approvalAction(action: string, reason?: string) {
    setBusy(action);
    const res = await fetch(`/api/campaigns/${params.id}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Action failed');
      return;
    }
    toast.success(`Campaign ${json.campaign.status.replace(/_/g, ' ').toLowerCase()}`);
    load();
  }

  async function send(skipApproval = false) {
    if (!confirm(`Send this campaign${skipApproval ? ' without approval' : ''}? Emails will go out from your Gmail account.`)) return;
    setBusy('send');
    const res = await fetch(`/api/campaigns/${params.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipApproval }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Send failed');
      if (json.validation) setValidation(json.validation);
      return;
    }
    toast.success(`Batch ${json.batch.label} created — ${json.batch.queued} queued.`);
    load();
  }

  async function batchControl(action: string) {
    if (!latestBatch) return;
    setBusy(action);
    const res = await fetch(`/api/batches/${latestBatch.id}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Action failed');
      return;
    }
    toast.success(json.note ?? `${action} done`);
    load();
    loadBatch();
  }

  async function drain() {
    if (!latestBatch) return;
    setBusy('drain');
    const res = await fetch(`/api/batches/${latestBatch.id}/drain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 25 }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Drain failed');
      return;
    }
    toast.success(`${json.sent} sent, ${json.failed} failed, ${json.remaining} remaining.`);
    load();
    loadBatch();
  }

  if (!data) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const canApprove = (data.viewerRole === 'ADMIN' || data.viewerRole === 'SUPER_ADMIN');
  const isAdmin = canApprove;

  return (
    <div className="p-6">
      <Link href="/campaigns" className="text-sm text-muted-foreground hover:text-foreground">
        ← Campaigns
      </Link>

      <div className="mb-4 mt-2 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{campaign.name}</h1>
          <p className="text-sm text-muted-foreground">
            {campaign.dataset.name} · {campaign.template.name} v{campaign.templateVersion.version} ·{' '}
            {campaign.status.replace(/_/g, ' ')}
          </p>
          {data.sender ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Sends from <strong>{data.sender.emailAddress}</strong> ({data.sender.status})
            </p>
          ) : (
            <p className="mt-1 text-xs text-primary">
              No Gmail account connected — <Link href="/settings" className="underline">connect one</Link> before sending.
            </p>
          )}
        </div>
      </div>

      {/* Workflow actions */}
      <div className="mb-6 flex flex-wrap gap-2">
        <button onClick={runSimulation} disabled={busy === 'simulate'} className="btn-secondary">
          {busy === 'simulate' ? 'Simulating…' : 'Run simulation (dry run)'}
        </button>
        {campaign.status === 'DRAFT' || campaign.status === 'REJECTED' ? (
          <button onClick={() => approvalAction('SUBMIT')} disabled={!!busy} className="btn-secondary">
            Submit for approval
          </button>
        ) : null}
        {campaign.status === 'PENDING_APPROVAL' && canApprove && !data.viewerIsCreator ? (
          <>
            <button onClick={() => approvalAction('APPROVE')} disabled={!!busy} className="btn-primary">
              Approve
            </button>
            <button
              onClick={() => approvalAction('REJECT', prompt('Reason for rejection?') ?? undefined)}
              disabled={!!busy}
              className="btn-secondary"
            >
              Reject
            </button>
          </>
        ) : null}
        {campaign.status === 'PENDING_APPROVAL' && data.viewerIsCreator && (
          <span className="self-center text-xs text-muted-foreground">
            Awaiting approval — you cannot approve your own campaign.
          </span>
        )}
        {campaign.status === 'APPROVED' && (
          <button onClick={() => send(false)} disabled={!!busy} className="btn-primary">
            {busy === 'send' ? 'Sending…' : 'Send now'}
          </button>
        )}
        {isAdmin && ['DRAFT', 'REJECTED'].includes(campaign.status) && (
          <button onClick={() => send(true)} disabled={!!busy} className="rounded-md border border-warning/40 px-3 py-1.5 text-sm text-warning hover:bg-warning/10">
            Send without approval (admin)
          </button>
        )}
      </div>

      {/* §22 sender settings */}
      <div className="mb-6">
        <SenderSettings
          campaignId={campaign.id}
          initial={{
            fromName: campaign.fromName ?? null,
            replyTo: campaign.replyTo ?? null,
            cc: campaign.ccEmails ?? [],
            bcc: campaign.bccEmails ?? [],
          }}
          senderEmail={data.sender?.emailAddress ?? null}
          senderStatus={data.sender?.status ?? null}
          locked={['RUNNING', 'COMPLETED', 'PARTIALLY_FAILED', 'CANCELLED'].includes(campaign.status)}
          onSaved={() => {
            load();
            loadPreview(preview?.preview?.recordId);
          }}
        />
      </div>

      {/* §113 pre-send review */}
      {preview && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">
            Review — nothing has been sent
          </h2>
          <CampaignReview
            data={preview}
            loadingRecipient={previewLoading}
            onSelectRecipient={(recordId) => loadPreview(recordId)}
          />
        </div>
      )}

      {campaign.rejectionReason && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-primary">
          <strong>Rejected:</strong> {campaign.rejectionReason}
        </div>
      )}

      {/* Validation */}
      {validation && validation.issues.length > 0 && (
        <div className="mb-4 rounded-lg border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">Validation</h2>
          <ul className="space-y-1 text-sm">
            {validation.issues.map((issue: any) => (
              <li key={issue.id} className={issue.level === 'error' ? 'text-primary' : 'text-warning'}>
                {issue.level === 'error' ? '✕' : '!'} {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Dry run results */}
      {simulation && (
        <div className="mb-6 rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">
            Simulation — no emails were sent
          </h2>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Evaluated" value={simulation.total} />
            <Stat label="Would send" value={simulation.wouldSend} tone="good" />
            <Stat label="Skipped" value={simulation.skipped} />
            <Stat label="Invalid" value={simulation.invalid} tone={simulation.invalid ? 'bad' : undefined} />
          </div>

          {Object.keys(simulation.byReason).length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              {Object.entries(simulation.byReason).map(([reason, count]) => (
                <span key={reason} className="rounded bg-muted px-2 py-1">
                  {REASON_LABELS[reason] ?? reason}: {count}
                </span>
              ))}
            </div>
          )}

          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Per-record detail ({simulation.evaluations.length}
              {simulation.truncated ? ' of many' : ''})
            </summary>
            <div className="mt-2 max-h-72 overflow-auto rounded border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="px-2 py-1 text-left">Email</th>
                    <th className="px-2 py-1 text-left">Outcome</th>
                    <th className="px-2 py-1 text-left">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {simulation.evaluations.map((e) => (
                    <tr key={e.recordId} className="border-t">
                      <td className="px-2 py-1">{e.email ?? '—'}</td>
                      <td className={`px-2 py-1 ${e.willSend ? 'text-success' : 'text-muted-foreground'}`}>
                        {e.willSend ? 'Would send' : REASON_LABELS[e.skipReason ?? ''] ?? 'Skipped'}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">{e.reasonDetail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}

      {/* Batch progress */}
      {latestBatch && (
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              Batch {latestBatch.label} — {latestBatch.status.replace(/_/g, ' ')}
            </h2>
            <div className="flex flex-wrap gap-2">
              <ExplainButton
                request={{ action: 'summarize_campaign', campaignId: params.id as string }}
                label="AI summary"
                className="rounded border border-primary/40 px-2 py-1 text-xs text-primary hover:bg-primary/10"
                compact
              />
              <button onClick={drain} disabled={!!busy} className="rounded border px-2 py-1 text-xs hover:bg-elevated">
                {busy === 'drain' ? 'Sending…' : 'Process queue'}
              </button>
              <button onClick={() => batchControl('PAUSE')} disabled={!!busy} className="rounded border px-2 py-1 text-xs hover:bg-elevated">
                Pause
              </button>
              <button onClick={() => batchControl('RESUME')} disabled={!!busy} className="rounded border px-2 py-1 text-xs hover:bg-elevated">
                Resume
              </button>
              <button onClick={() => batchControl('CANCEL')} disabled={!!busy} className="rounded border px-2 py-1 text-xs hover:bg-elevated">
                Cancel
              </button>
              <button onClick={() => batchControl('RETRY_FAILED')} disabled={!!busy} className="rounded border px-2 py-1 text-xs hover:bg-elevated">
                Retry failed
              </button>
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Total" value={latestBatch.total} />
            <Stat label="Sent" value={latestBatch.sentCount} tone="good" />
            <Stat label="Failed" value={latestBatch.failedCount} tone={latestBatch.failedCount ? 'bad' : undefined} />
            <Stat label="Skipped" value={latestBatch.skippedCount} />
          </div>

          <div className="mb-3 h-2 overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${latestBatch.total ? (latestBatch.sentCount / latestBatch.total) * 100 : 0}%` }}
            />
          </div>

          {batch?.jobs?.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">Job detail</summary>
              <div className="mt-2 max-h-72 overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="px-2 py-1 text-left">To</th>
                      <th className="px-2 py-1 text-left">Status</th>
                      <th className="px-2 py-1 text-left">Detail</th>
                      <th className="px-2 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {batch.jobs.map((j: any) => (
                      <tr key={j.id} className="border-t">
                        <td className="px-2 py-1">{j.toEmail}</td>
                        <td className="px-2 py-1">{j.status}</td>
                        <td className="px-2 py-1 text-muted-foreground">
                          {j.errorMessage ?? j.skipReason ?? (j.gmailThreadId ? `thread ${j.gmailThreadId.slice(0, 10)}…` : '')}
                        </td>
                        <td className="relative px-2 py-1 text-right">
                          <ExplainButton request={{ action: 'explain_send', emailJobId: j.id }} label="Why?" className="text-[11px] text-muted-foreground hover:text-primary" compact />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  const color = tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-primary' : '';
  return (
    <div className="rounded border p-2">
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
