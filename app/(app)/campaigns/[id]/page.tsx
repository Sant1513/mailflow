'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { ExplainButton } from '@/components/ai/ExplainButton';
import { SenderSettings } from '@/components/campaign/SenderSettings';
import { CampaignReview, type CampaignPreview } from '@/components/campaign/CampaignReview';
import { CampaignDocuments } from '@/components/campaign/CampaignDocuments';
import { useDocumentPreview } from '@/components/documents/PdfPreviewDialog';

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
  MISSING_DOCUMENT_FIELD: 'Missing document value',
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
  const { openPreview, previewDialog } = useDocumentPreview();
  const previewDocument = useCallback(
    (campaignDocumentId: string, name: string, recordId?: string | null) => {
      openPreview(`/api/campaigns/${params.id}/documents/${campaignDocumentId}/preview`, recordId ? { recordId } : {}, name);
    },
    [openPreview, params.id]
  );

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

  const TERMINAL = new Set(['COMPLETED', 'FAILED', 'PARTIALLY_FAILED', 'CANCELLED']);
  const isLive = campaign && !TERMINAL.has(campaign.status) && campaign.status !== 'DRAFT' && campaign.status !== 'APPROVED' && campaign.status !== 'PENDING_APPROVAL' && campaign.status !== 'REJECTED' && campaign.status !== 'SCHEDULED';
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!isLive) return;
    pollRef.current = setInterval(() => {
      load();
      loadBatch();
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

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

  const [scheduledAt, setScheduledAt] = useState('');
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT' | null>(null);

  // Draft configuration — dataset / template swap + version re-sync.
  const [datasets, setDatasets] = useState<{ id: string; name: string; _count: { records: number } }[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string; versions: { version: number }[] }[]>([]);
  const [swapDatasetId, setSwapDatasetId] = useState('');
  const [swapTemplateId, setSwapTemplateId] = useState('');

  useEffect(() => {
    if (!campaign || campaign.status !== 'DRAFT') return;
    fetch('/api/datasets').then((r) => r.json()).then((j) => setDatasets(j.datasets ?? [])).catch(() => undefined);
    fetch('/api/templates').then((r) => r.json()).then((j) => setTemplates(j.templates ?? [])).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.status]);

  async function swapConfig(patch: { datasetId?: string; templateId?: string }) {
    const label = patch.datasetId ? 'Change dataset?' : 'Change template? The campaign will use the latest version.';
    if (!confirm(label)) return;
    setBusy('swap');
    const res = await fetch(`/api/campaigns/${params.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) { toast.error(json.error ?? 'Update failed'); return; }
    toast.success(patch.datasetId ? 'Dataset updated.' : 'Template updated to latest version.');
    setSwapDatasetId('');
    setSwapTemplateId('');
    load();
    loadPreview();
  }
  const [decisionReason, setDecisionReason] = useState('');
  const [decisionRemarks, setDecisionRemarks] = useState('');

  async function approvalAction(action: string, reason?: string, remarks?: string) {
    if (action === 'REJECT' && !reason?.trim()) {
      toast.error('A reason is required — the requester will see it.');
      return;
    }
    setBusy(action);
    const res = await fetch(`/api/campaigns/${params.id}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason: reason?.trim() || undefined, remarks: remarks?.trim() || undefined }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Action failed');
      return;
    }
    const email = json.emailStatus ? ` · email: ${json.emailStatus}` : '';
    toast.success(`Campaign ${json.campaign.status.replace(/_/g, ' ').toLowerCase()}${email}`, { duration: 8000 });
    setDecision(null);
    setDecisionReason('');
    setDecisionRemarks('');
    load();
  }

  async function send(skipApproval = false, overrideScheduledAt?: string) {
    const label = overrideScheduledAt
      ? `Schedule send for ${new Date(overrideScheduledAt).toLocaleString('en-IN')}?`
      : `Send this campaign${skipApproval ? ' without approval' : ''}? Emails will go out from your Gmail account.`;
    if (!confirm(label)) return;
    setBusy('send');
    const res = await fetch(`/api/campaigns/${params.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skipApproval,
        ...(overrideScheduledAt ? { scheduledAt: overrideScheduledAt } : {}),
      }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Send failed');
      if (json.validation) setValidation(json.validation);
      return;
    }
    if (json.scheduled) {
      toast.success(`Scheduled for ${new Date(json.scheduledAt).toLocaleString('en-IN')} — ${json.batch.queued} emails queued.`, { duration: 8000 });
    } else {
      toast.success(`Batch ${json.batch.label} created — ${json.batch.queued} queued.`);
    }
    setScheduledAt('');
    load();
  }

  async function sendImmediately() {
    if (!confirm('Send now, ignoring the scheduled time? This cannot be undone.')) return;
    setBusy('sendNow');
    const res = await fetch(`/api/campaigns/${params.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipApproval: false }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Send failed');
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

  async function verifyAttachment(attachmentId: string) {
    const res = await fetch(`/api/attachments/${attachmentId}?verify=1`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error ?? 'Could not verify the document');
      return;
    }
    if (json.verification === 'identical') {
      toast.success(`${json.filename} (${json.reference}) regenerates byte-for-byte identical to the copy sent to ${json.recipient}.`, { duration: 8000 });
    } else if (json.verification === 'not-sent-yet') {
      toast.message(`${json.filename} has not been sent yet.`);
    } else {
      toast.error(`${json.filename} does not match the hash recorded when it was sent.`);
    }
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

      {/* Draft configuration — swap dataset / template, re-sync version */}
      {(campaign.status === 'DRAFT' || campaign.status === 'REJECTED') && (
        <div className="mb-5 rounded-lg border border-border bg-card p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Configuration</div>
          <div className="grid gap-4 sm:grid-cols-2">

            {/* Dataset */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground">Dataset</label>
              <p className="mb-1 text-sm font-medium">{campaign.dataset.name}</p>
              {datasets.length > 0 && (
                <div className="flex items-center gap-2">
                  <select
                    value={swapDatasetId}
                    onChange={(e) => setSwapDatasetId(e.target.value)}
                    className="!py-1 text-xs"
                  >
                    <option value="">Switch dataset…</option>
                    {datasets.filter((d) => d.id !== campaign.datasetId).map((d) => (
                      <option key={d.id} value={d.id}>{d.name} ({d._count.records} rows)</option>
                    ))}
                  </select>
                  {swapDatasetId && (
                    <button
                      onClick={() => swapConfig({ datasetId: swapDatasetId })}
                      disabled={busy === 'swap'}
                      className="btn-secondary !px-2 !py-1 text-xs"
                    >
                      Apply
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Template + version re-sync */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground">Template</label>
              <p className="mb-1 text-sm font-medium">
                {campaign.template.name}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  using v{campaign.templateVersion.version}
                  {data.latestTemplateVersion && data.latestTemplateVersion.version > campaign.templateVersion.version && (
                    <span className="ml-1 text-warning">(v{data.latestTemplateVersion.version} available)</span>
                  )}
                </span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {/* Sync to latest version button */}
                {data.latestTemplateVersion && data.latestTemplateVersion.version > campaign.templateVersion.version && (
                  <button
                    onClick={() => swapConfig({ templateId: campaign.templateId })}
                    disabled={busy === 'swap'}
                    className="btn-secondary !px-2 !py-1 text-xs text-warning border-warning/50 hover:bg-warning/10"
                  >
                    Sync to v{data.latestTemplateVersion.version}
                  </button>
                )}
                {/* Switch to a different template */}
                {templates.length > 0 && (
                  <div className="flex items-center gap-2">
                    <select
                      value={swapTemplateId}
                      onChange={(e) => setSwapTemplateId(e.target.value)}
                      className="!py-1 text-xs"
                    >
                      <option value="">Switch template…</option>
                      {templates.filter((t) => t.id !== campaign.templateId).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} (v{t.versions[0]?.version ?? '?'})
                        </option>
                      ))}
                    </select>
                    {swapTemplateId && (
                      <button
                        onClick={() => swapConfig({ templateId: swapTemplateId })}
                        disabled={busy === 'swap'}
                        className="btn-secondary !px-2 !py-1 text-xs"
                      >
                        Apply
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

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
        {campaign.status === 'PENDING_APPROVAL' && canApprove && (!data.viewerIsCreator || data.viewerRole === 'SUPER_ADMIN') ? (
          <>
            <button onClick={() => setDecision('APPROVE')} disabled={!!busy} className="btn-primary">
              Approve
            </button>
            <button onClick={() => setDecision('REJECT')} disabled={!!busy} className="btn-secondary">
              Reject
            </button>
          </>
        ) : null}
        {campaign.status === 'PENDING_APPROVAL' && data.viewerIsCreator && data.viewerRole !== 'SUPER_ADMIN' && (
          <span className="self-center text-xs text-muted-foreground">
            Awaiting approval — you cannot approve your own campaign.
          </span>
        )}
        {campaign.status === 'APPROVED' && (
          <>
            <button onClick={() => send(false)} disabled={!!busy} className="btn-primary">
              {busy === 'send' ? 'Sending…' : 'Send now'}
            </button>
            <div className="flex items-center gap-1">
              <input
                type="datetime-local"
                value={scheduledAt}
                min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
              <button
                onClick={() => scheduledAt && send(false, new Date(scheduledAt).toISOString())}
                disabled={!!busy || !scheduledAt}
                className="btn-secondary"
              >
                Schedule send
              </button>
            </div>
          </>
        )}
        {campaign.status === 'SCHEDULED' && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              Scheduled for{' '}
              <strong>{campaign.scheduledAt ? new Date(campaign.scheduledAt).toLocaleString('en-IN') : '—'}</strong>
            </span>
            <button onClick={sendImmediately} disabled={!!busy} className="btn-secondary">
              {busy === 'sendNow' ? 'Sending…' : 'Send immediately'}
            </button>
          </div>
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

      {/* Personalised PDFs attached to every email */}
      <div className="mb-6">
        <CampaignDocuments
          campaignId={campaign.id}
          onChanged={() => {
            load();
            loadPreview(preview?.preview?.recordId);
          }}
          onPreview={(documentId, name) => previewDocument(documentId, name, preview?.preview?.recordId)}
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
            onPreviewDocument={(documentId, name, recordId) => previewDocument(documentId, name, recordId)}
          />
        </div>
      )}

      {(campaign.submittedAt || campaign.rejectionReason || campaign.approvedAt) && (
        <div className="mb-4 rounded-md border border-border-subtle bg-elevated/30 p-3 text-xs">
          <div className="mb-1 font-semibold uppercase tracking-wider text-muted-foreground">Approval</div>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {campaign.submittedAt && <div><dt className="text-faint">Submitted</dt><dd>{new Date(campaign.submittedAt).toLocaleString('en-IN')}</dd></div>}
            {campaign.approvedAt && <div><dt className="text-faint">Approved</dt><dd className="text-success">{new Date(campaign.approvedAt).toLocaleString('en-IN')}</dd></div>}
            {campaign.rejectedAt && <div><dt className="text-faint">Rejected</dt><dd className="text-primary">{new Date(campaign.rejectedAt).toLocaleString('en-IN')}</dd></div>}
            {campaign.approvalRequestEmail && <div><dt className="text-faint">Request email</dt><dd>{campaign.approvalRequestEmail}</dd></div>}
            {campaign.approvalDecisionEmail && <div><dt className="text-faint">Decision email</dt><dd>{campaign.approvalDecisionEmail}</dd></div>}
            {campaign.rejectionReason && <div className="sm:col-span-2"><dt className="text-faint">Reason</dt><dd className="text-primary">{campaign.rejectionReason}</dd></div>}
            {isAdmin && campaign.approvalRemarks && <div className="sm:col-span-2"><dt className="text-faint">Reviewer remarks (internal)</dt><dd>{campaign.approvalRemarks}</dd></div>}
          </dl>
        </div>
      )}

      {decision && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={() => !busy && setDecision(null)}>
          <div className="panel w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
            <div className="eyebrow mb-2">{decision === 'APPROVE' ? 'Approve' : 'Reject'}</div>
            <h2 className="font-heading text-lg font-bold">{campaign.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">The requester is emailed in the same thread as their approval request.</p>
            {decision === 'REJECT' && (
              <label className="mt-4 block text-xs">
                <span className="font-medium">Reason <span className="text-primary">*</span> <span className="text-faint">— sent to the requester</span></span>
                <textarea value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} rows={3} className="mt-1 w-full text-sm" />
              </label>
            )}
            <label className="mt-3 block text-xs">
              <span className="font-medium">Remarks <span className="text-faint">— internal</span></span>
              <textarea value={decisionRemarks} onChange={(e) => setDecisionRemarks(e.target.value)} rows={2} className="mt-1 w-full text-sm" />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setDecision(null)} disabled={!!busy} className="btn-secondary">Cancel</button>
              <button onClick={() => approvalAction(decision, decisionReason, decisionRemarks)} disabled={!!busy} className="btn-primary">
                {busy ? 'Saving…' : decision === 'APPROVE' ? 'Approve campaign' : 'Reject campaign'}
              </button>
            </div>
          </div>
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
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              Batch {latestBatch.label} — {latestBatch.status.replace(/_/g, ' ')}
              {isLive && (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                  Live
                </span>
              )}
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
                      <th className="px-2 py-1 text-left">PDF</th>
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
                        <td className="px-2 py-1">
                          {(j.attachments ?? []).map((a: any) => (
                            <span key={a.id} className="mr-2 inline-flex items-center gap-1 whitespace-nowrap">
                              <a href={`/api/attachments/${a.id}`} className="text-primary hover:underline" title={a.documentRef ?? ''}>
                                📎 {a.filename}
                              </a>
                              {a.sha256 && (
                                <button onClick={() => verifyAttachment(a.id)} className="text-[11px] text-muted-foreground hover:text-primary">
                                  Verify
                                </button>
                              )}
                            </span>
                          ))}
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

      {previewDialog}
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
