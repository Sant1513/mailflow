'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoadError, loadErrorMessage } from '@/components/ui/LoadError';
import { LoadingScreen } from '@/components/loading/LoadingScreen';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Avatar } from '@/components/ui/Avatar';
import { toast } from 'sonner';
import { ExplainButton } from '@/components/ai/ExplainButton';
import { SenderSettings } from '@/components/campaign/SenderSettings';
import { FallbackSenders } from '@/components/campaign/FallbackSenders';
import { CampaignRsvp } from '@/components/rsvp/CampaignRsvp';
import { CampaignReplyRules } from '@/components/replyRules/CampaignReplyRules';
import { CampaignReview, type CampaignPreview } from '@/components/campaign/CampaignReview';
import { CampaignDocuments } from '@/components/campaign/CampaignDocuments';
import { useDocumentPreview } from '@/components/documents/PdfPreviewDialog';
import { ExportMenu } from '@/components/ui/ExportMenu';
import { Search, X } from 'lucide-react';
import { ListPager } from '@/components/ui/ListPager';
import { SortTh } from '@/components/ui/SortTh';
import { sortRows, nextSort, type SortDir } from '@/lib/ui/sort';

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
  SUPPRESSED: 'Unsubscribed or bounced before',
  BAD_ADDRESS: 'Address would bounce',
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

  // ── Analytics ─────────────────────────────────────────────────────────────
  const [mainView, setMainView] = useState<'details' | 'analytics'>('details');
  const [analyticsTab, setAnalyticsTab] = useState('overview');
  const [analyticsData, setAnalyticsData] = useState<any>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsPage, setAnalyticsPage] = useState(1);
  const [analyticsView, setAnalyticsView] = useState({ q: '', sort: '', dir: '', pageSize: 50 });
  const { openPreview, previewDialog } = useDocumentPreview();
  const previewDocument = useCallback(
    (campaignDocumentId: string, name: string, recordId?: string | null) => {
      openPreview(`/api/campaigns/${params.id}/documents/${campaignDocumentId}/preview`, recordId ? { recordId } : {}, name);
    },
    [openPreview, params.id]
  );

  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${params.id}`).catch(() => null);
    if (!res?.ok) {
      const message = await loadErrorMessage(res, 'campaign');
      setLoadError(message);
      toast.error(message);
      return;
    }
    setLoadError(null);
    setData(await res.json());
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  const campaign = data?.campaign;
  const latestBatch = campaign?.batches?.[0];

  const TERMINAL = new Set(['COMPLETED', 'FAILED', 'PARTIALLY_FAILED', 'CANCELLED']);
  const isLive = campaign && !TERMINAL.has(campaign.status) && campaign.status !== 'DRAFT' && campaign.status !== 'APPROVED' && campaign.status !== 'PENDING_APPROVAL' && campaign.status !== 'REJECTED' && campaign.status !== 'SCHEDULED';
  // While a batch is live, refresh only the batch (counts, status, one page of jobs) every 15 s,
  // and the whole campaign only when the batch or campaign status changes. Paused while the tab
  // is hidden, and refreshed as soon as it is shown again (free-tier requests and data transfer).
  const lastStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isLive || !latestBatch?.id) return;
    const id = latestBatch.id;
    let stopped = false;
    const tick = async () => {
      if (stopped || document.hidden) return;
      const res = await fetch(`/api/batches/${id}`).catch(() => null);
      if (stopped || !res?.ok) return;
      const json = await res.json();
      setBatch(json);
      const status = `${json?.batch?.status ?? ''}/${json?.batch?.campaign?.status ?? ''}`;
      if (lastStatusRef.current !== null && status !== lastStatusRef.current) load();
      lastStatusRef.current = status;
    };
    const t = setInterval(tick, 15_000);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isLive, latestBatch?.id, load]);

  const autoSendRef = useRef(false);
  useEffect(() => {
    if (!isLive || campaign?.status === 'PAUSED' || !latestBatch) return;
    let stopped = false;
    const pass = async () => {
      // The server sends on its own (cron/send-queue); this only speeds it up while someone is
      // watching, so a hidden tab doesn't keep driving it.
      if (stopped || autoSendRef.current || document.hidden) return;
      autoSendRef.current = true;
      try {
        const res = await fetch(`/api/batches/${latestBatch.id}/drain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seconds: 40 }),
        });
        const json = await res.json().catch(() => ({}));
        // Stop when done, on an error, or when the server's own sender already has it (busy) or
        // every mailbox is on hold: calling again would only spend a request to hear the same.
        if (!res.ok || !json.remaining || json.busy || json.held) stopped = true;
      } catch {
        /* network hiccup: the server keeps sending; try again on the next tick */
      } finally {
        autoSendRef.current = false;
      }
    };
    pass();
    const t = setInterval(pass, 15_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, campaign?.status, latestBatch?.id]);

  const latestBatchId = latestBatch?.id;
  const loadBatch = useCallback(async () => {
    if (!latestBatchId) return;
    const res = await fetch(`/api/batches/${latestBatchId}`);
    if (res.ok) setBatch(await res.json());
  }, [latestBatchId]);
  // The batch endpoint's copy is fresher than the campaign's while the poll above runs.
  const liveBatch = latestBatch && batch?.batch?.id === latestBatch.id ? { ...latestBatch, ...batch.batch } : latestBatch;

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
      body: JSON.stringify({ seconds: 40 }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Drain failed');
      return;
    }
    if (json.busy) toast.info(`${json.note} ${json.remaining} remaining.`);
    else toast.success(`${json.sent} sent, ${json.failed} failed, ${json.remaining} remaining.${json.remaining ? ' Sending continues automatically.' : ''}`);
    load();
    loadBatch();
  }

  const loadAnalytics = useCallback(async (tab = analyticsTab, pg = analyticsPage) => {
    setAnalyticsLoading(true);
    const qs = new URLSearchParams({ tab, page: String(pg), pageSize: String(analyticsView.pageSize) });
    if (analyticsView.q) qs.set('q', analyticsView.q);
    if (analyticsView.sort) qs.set('sort', analyticsView.sort);
    if (analyticsView.dir) qs.set('dir', analyticsView.dir);
    const res = await fetch(`/api/campaigns/${params.id}/analytics?${qs}`);
    setAnalyticsLoading(false);
    if (res.ok) setAnalyticsData(await res.json());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, analyticsTab, analyticsPage, analyticsView]);

  useEffect(() => {
    if (mainView === 'analytics') loadAnalytics(analyticsTab, analyticsPage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainView, analyticsTab, analyticsPage, analyticsView]);

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

  if (!data) return loadError ? <LoadError message={loadError} onRetry={load} backHref="/campaigns" backLabel="Back to campaigns" /> : <LoadingScreen context={['Opening this campaign…']} />;

  const canApprove = (data.viewerRole === 'ADMIN' || data.viewerRole === 'SUPER_ADMIN');
  const isAdmin = canApprove;

  return (
    <div className="p-6">
      <Link href="/campaigns" className="text-sm text-muted-foreground hover:text-foreground">
        ← Campaigns
      </Link>

      <div className="mb-4 mt-2 flex items-start justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">{campaign.name}</h1>
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
        <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Who opened / didn't, as CSV, once anything has gone out */}
        {['COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'SENDING', 'RUNNING', 'PAUSED', 'CANCELLED'].includes(campaign.status) && <ExportMenu href={`/api/campaigns/${campaign.id}/export`} />}
        {/* View toggle — analytics only for sent campaigns */}
        {['COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'SENDING'].includes(campaign.status) && (
          <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
            {(['details', 'analytics'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setMainView(v)}
                className={`rounded-md px-3 py-1 text-sm font-medium transition ${mainView === v ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {v === 'details' ? 'Details' : 'Analytics'}
              </button>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* ── Analytics dashboard ──────────────────────────────────────────── */}
      {mainView === 'analytics' && <CampaignAnalytics campaignId={params.id} data={analyticsData} loading={analyticsLoading} tab={analyticsTab} page={analyticsPage} view={analyticsView} onView={(v) => { setAnalyticsView((cur) => ({ ...cur, ...v })); setAnalyticsPage(1); }} onTabChange={(t) => { setAnalyticsTab(t); setAnalyticsPage(1); setAnalyticsView((cur) => ({ ...cur, q: '', sort: '', dir: '' })); }} onPageChange={setAnalyticsPage} />}

      {mainView === 'details' && (<>

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

      {/* Backup sender mailboxes (used when the campaign mailbox hits a Google limit) */}
      <div className="mb-6">
        <FallbackSenders campaignId={campaign.id} refreshKey={campaign.status} />
      </div>

      {/* RSVP buttons in the email, and who answered what */}
      <section id="rsvp" className="mb-6 rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">RSVP buttons</h2>
        <CampaignRsvp campaignId={campaign.id} canEdit={!['CANCELLED'].includes(campaign.status)} />
      </section>

      {/* Follow-up branches by the type of reply */}
      <section id="reply-rules" className="mb-6 rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">When someone replies</h2>
        <CampaignReplyRules campaignId={campaign.id} canEdit={!['CANCELLED'].includes(campaign.status)} />
      </section>

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
      {liveBatch && (
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              Batch {liveBatch.label} — {liveBatch.status.replace(/_/g, ' ')}
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
                {busy === 'drain' ? 'Sending…' : 'Send now'}
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
            <Stat label="Total" value={liveBatch.total} />
            <Stat label="Sent" value={liveBatch.sentCount} tone="good" />
            <Stat label="Failed" value={liveBatch.failedCount} tone={liveBatch.failedCount ? 'bad' : undefined} />
            <Stat label="Skipped" value={liveBatch.skippedCount} />
          </div>

          <div className="mb-3 h-2 overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${liveBatch.total ? (liveBatch.sentCount / liveBatch.total) * 100 : 0}%` }}
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
                        <td className="px-2 py-1"><span className="flex items-center gap-2"><Avatar email={j.toEmail} size={20} />{j.toEmail}</span></td>
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
      </>)}
    </div>
  );
}

// ── Campaign Analytics Dashboard ──────────────────────────────────────────

const ANALYTICS_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'sent',     label: 'Sent' },
  { key: 'read',     label: 'Read' },
  { key: 'clicked',  label: 'Clicked' },
  { key: 'replied',  label: 'Replied' },
  { key: 'unopened', label: 'Not opened' },
  { key: 'failed',   label: 'Failed' },
] as const;

type AnalyticsTabKey = typeof ANALYTICS_TABS[number]['key'];

function statCount(data: any, tab: AnalyticsTabKey): number {
  if (!data?.stats) return 0;
  const s = data.stats;
  return ({ overview: s.audience, sent: s.sent, read: s.opens, clicked: s.clicks, replied: s.replied, unopened: s.unopened, failed: s.failed } as Record<string, number>)[tab] ?? 0;
}

function MiniChart({ trend }: { trend: { day: string; sent: number; opens: number; clicks: number; failed: number }[] }) {
  if (!trend?.length) return null;
  const maxVal = Math.max(...trend.map((d) => Math.max(d.sent, d.opens, d.clicks, d.failed)), 1);
  const H = 80;
  const series = [
    { key: 'sent' as const,   color: 'bg-primary/70',   label: 'Sent' },
    { key: 'opens' as const,  color: 'bg-blue-400/70',  label: 'Opened' },
    { key: 'clicks' as const, color: 'bg-green-400/70', label: 'Clicked' },
    { key: 'failed' as const, color: 'bg-destructive/70', label: 'Failed' },
  ];
  return (
    <div className="mt-4 rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold">Campaign messages (per day)</span>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.color}`} />{s.label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-end gap-0.5 overflow-x-auto" style={{ height: H + 4 }}>
        {trend.map((d) => (
          <div key={d.day} className="group relative flex min-w-0 flex-1 flex-col justify-end gap-px"
            title={`${d.day}\nSent: ${d.sent}  Opened: ${d.opens}  Clicked: ${d.clicks}  Failed: ${d.failed}`}>
            {series.map((s) => (
              <div key={s.key} className={`w-full rounded-sm ${s.color}`}
                style={{ height: d[s.key] > 0 ? Math.max(2, Math.round((d[s.key] / maxVal) * H / series.length)) : 0 }} />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-faint">
        <span>{trend[0]?.day}</span>
        <span>{trend[trend.length - 1]?.day}</span>
      </div>
    </div>
  );
}

const fmtDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
/** 95 s → "1 min", 5400 s → "1.5 h", 200000 s → "2.3 d" */
function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round((s / 3600) * 10) / 10} h`;
  return `${Math.round((s / 86400) * 10) / 10} d`;
}

const TAB_COLUMNS: Record<string, { key: string; label: string; first?: 'asc' | 'desc'; right?: boolean }[]> = {
  sent: [{ key: 'toEmail', label: 'Email' }, { key: 'subject', label: 'Subject' }, { key: 'sentAt', label: 'Sent', first: 'desc', right: true }],
  read: [
    { key: 'email', label: 'Email' }, { key: 'opens', label: 'Times opened', first: 'desc', right: true }, { key: 'clicks', label: 'Clicks', first: 'desc', right: true },
    { key: 'device', label: 'Device' }, { key: 'secondsToFirstOpen', label: 'Time to open', right: true },
    { key: 'firstOpenedAt', label: 'First opened', first: 'desc', right: true }, { key: 'lastOpenedAt', label: 'Last opened', first: 'desc', right: true },
  ],
  unopened: [{ key: 'email', label: 'Email' }, { key: 'sentAt', label: 'Sent', first: 'desc', right: true }],
  clicked: [
    { key: 'email', label: 'Email' }, { key: 'clicks', label: 'Clicks', first: 'desc', right: true }, { key: 'links', label: 'Different links', first: 'desc', right: true },
    { key: 'firstClickedAt', label: 'First clicked', first: 'desc', right: true }, { key: 'lastClickedAt', label: 'Last clicked', first: 'desc', right: true },
  ],
  replied: [{ key: 'recipientEmail', label: 'Email' }, { key: 'subject', label: 'Subject' }, { key: 'status', label: 'Status' }, { key: 'createdAt', label: 'Replied', first: 'desc', right: true }],
  failed: [{ key: 'toEmail', label: 'Email' }, { key: 'errorCode', label: 'Error' }, { key: 'lastAttemptAt', label: 'Last attempt', first: 'desc', right: true }],
};

function TabRows({ tab, tabData, loading, view, onView, page, onPage }: {
  tab: AnalyticsTabKey;
  tabData: any;
  loading: boolean;
  view: { q: string; sort: string; dir: string; pageSize: number };
  onView: (v: Partial<{ q: string; sort: string; dir: string; pageSize: number }>) => void;
  page: number;
  onPage: (n: number) => void;
}) {
  const [text, setText] = useState(view.q);
  // Search as you type, a moment after the last key.
  useEffect(() => {
    if (text === view.q) return;
    const t = setTimeout(() => onView({ q: text }), 350);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const cols = TAB_COLUMNS[tab] ?? [];
  const sort = { key: tabData?.sort?.key ?? '', dir: (tabData?.sort?.dir ?? 'desc') as SortDir };
  const onSort = (key: string, first: SortDir) => {
    const n = nextSort(sort, key, first);
    onView({ sort: n.key, dir: n.dir });
  };
  const total = tabData?.total ?? 0;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by email…" aria-label="Search this list" data-analytics-search className="w-full rounded-md border bg-card py-1.5 pl-8 pr-8 text-sm" />
          {text && <button type="button" aria-label="Clear search" onClick={() => { setText(''); onView({ q: '' }); }} className="absolute right-2 top-1.5 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>}
        </div>
        {loading && <span className="text-xs text-muted-foreground">Updating…</span>}
      </div>
      {!tabData ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No data.</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm" data-analytics-table={tab}>
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  {cols.map((c) => <SortTh key={c.key} label={c.label} k={c.key} sort={sort} onSort={onSort} first={c.first ?? 'asc'} align={c.right ? 'right' : 'left'} />)}
                </tr>
              </thead>
              <tbody>
                {tabData.rows.map((row: any, i: number) => (
                  <tr key={`${row.email ?? row.toEmail ?? row.recipientEmail}-${i}`} className={`border-t border-border-subtle ${i % 2 === 1 ? 'bg-muted/30' : ''}`}>
                    {tab === 'sent' && <><td className="px-4 py-2 font-mono text-xs">{row.toEmail}</td><td className="max-w-xs truncate px-4 py-2 text-xs text-muted-foreground">{row.subject}</td><td className="whitespace-nowrap px-4 py-2 text-right text-xs text-muted-foreground">{fmtDate(row.sentAt)}</td></>}
                    {tab === 'read' && (
                      <>
                        <td className="px-4 py-2 font-mono text-xs">{row.email}</td>
                        <td className="px-4 py-2 text-right text-xs tabular-nums"><span className={row.opens > 1 ? 'font-semibold text-success' : ''}>{row.opens}×</span></td>
                        <td className="px-4 py-2 text-right text-xs tabular-nums text-muted-foreground">{row.clicks || '—'}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground" title={row.client}>{row.device}{row.client && row.client !== 'Unknown' ? ` · ${row.client}` : ''}</td>
                        <td className="px-4 py-2 text-right text-xs tabular-nums text-muted-foreground">{fmtDuration(row.secondsToFirstOpen)}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-muted-foreground">{fmtDate(row.firstOpenedAt)}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-muted-foreground">{fmtDate(row.lastOpenedAt)}</td>
                      </>
                    )}
                    {tab === 'unopened' && <><td className="px-4 py-2 font-mono text-xs">{row.email}</td><td className="whitespace-nowrap px-4 py-2 text-right text-xs text-muted-foreground">{fmtDate(row.sentAt)}</td></>}
                    {tab === 'clicked' && (
                      <>
                        <td className="px-4 py-2 font-mono text-xs">{row.email}<div className="max-w-xs truncate font-sans text-[11px] text-faint" title={row.topUrl ?? ''}>{row.topUrl}</div></td>
                        <td className="px-4 py-2 text-right text-xs tabular-nums">{row.clicks}×</td>
                        <td className="px-4 py-2 text-right text-xs tabular-nums text-muted-foreground">{row.links}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-muted-foreground">{fmtDate(row.firstClickedAt)}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-muted-foreground">{fmtDate(row.lastClickedAt)}</td>
                      </>
                    )}
                    {tab === 'replied' && <><td className="px-4 py-2 font-mono text-xs">{row.recipientEmail}</td><td className="max-w-xs truncate px-4 py-2 text-xs">{row.subject}</td><td className="px-4 py-2"><span className="badge badge-info text-xs">{row.status}</span></td><td className="whitespace-nowrap px-4 py-2 text-right text-xs text-muted-foreground">{fmtDate(row.createdAt)}</td></>}
                    {tab === 'failed' && (
                      <>
                        <td className="px-4 py-2 font-mono text-xs">{row.toEmail}</td>
                        <td className="max-w-sm truncate px-4 py-2 text-xs text-destructive">{row.errorCode && <span className="mr-1 font-semibold">[{row.errorCode}]</span>}{row.errorMessage}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-muted-foreground">{fmtDate(row.lastAttemptAt)}</td>
                      </>
                    )}
                  </tr>
                ))}
                {tabData.rows.length === 0 && (
                  <tr><td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">{view.q ? `No record matches “${view.q}”.` : 'No records.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <ListPager page={page} pageSize={tabData.pageSize ?? view.pageSize} total={total} onPage={onPage} onPageSize={(n) => onView({ pageSize: n })} noun="records" className="mt-1" />
        </>
      )}
    </div>
  );
}

function Bars({ title, values, labels, color = 'bg-primary/70', note }: { title: string; values: number[]; labels: string[]; color?: string; note?: string }) {
  const max = Math.max(...values, 1);
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <div className="flex h-24 items-end gap-0.5">
        {values.map((v, i) => (
          <div key={i} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${labels[i]}: ${v}`}>
            <div className={`w-full rounded-sm ${color}`} style={{ height: v > 0 ? `${Math.max(3, (v / max) * 100)}%` : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-faint"><span>{labels[0]}</span><span>{labels[Math.floor(labels.length / 2)]}</span><span>{labels[labels.length - 1]}</span></div>
      {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

function Share({ title, items, empty }: { title: string; items: { label: string; count: number }[]; empty: string }) {
  const total = items.reduce((s, i) => s + i.count, 0);
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      {total === 0 ? <div className="text-xs text-muted-foreground">{empty}</div> : (
        <ul className="space-y-1.5">
          {items.slice(0, 6).map((i) => (
            <li key={i.label} className="text-xs">
              <div className="flex justify-between"><span>{i.label}</span><span className="tabular-nums text-muted-foreground">{i.count} · {Math.round((i.count / total) * 100)}%</span></div>
              <div className="mt-0.5 h-1.5 rounded bg-muted"><div className="h-1.5 rounded bg-primary/70" style={{ width: `${(i.count / total) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TopLinks({ links }: { links: { url: string; clicks: number; people: number }[] }) {
  const [sort, setSort] = useState<{ key: 'url' | 'clicks' | 'people'; dir: SortDir }>({ key: 'clicks', dir: 'desc' });
  const rows = sortRows(links, (l) => l[sort.key], sort.dir);
  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b px-4 py-2 text-sm font-semibold">Which links get clicked</div>
      {links.length === 0 ? <div className="px-4 py-4 text-xs text-muted-foreground">No link has been clicked yet.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-top-links>
            <thead className="bg-muted text-xs text-muted-foreground">
              <tr>
                <SortTh label="Link" k="url" sort={sort} onSort={(k, f) => setSort((c) => nextSort(c, k, f))} />
                <SortTh label="Clicks" k="clicks" sort={sort} onSort={(k, f) => setSort((c) => nextSort(c, k, f))} first="desc" align="right" />
                <SortTh label="People" k="people" sort={sort} onSort={(k, f) => setSort((c) => nextSort(c, k, f))} first="desc" align="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.url} className="border-t border-border-subtle">
                  <td className="max-w-md truncate px-4 py-2 text-xs" title={l.url}>{l.url}</td>
                  <td className="px-4 py-2 text-right text-xs tabular-nums">{l.clicks}</td>
                  <td className="px-4 py-2 text-right text-xs tabular-nums text-muted-foreground">{l.people}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CampaignAnalytics({ campaignId, data, loading, tab, page, view, onView, onTabChange, onPageChange }: {
  campaignId: string;
  data: any;
  loading: boolean;
  tab: string;
  page: number;
  view: { q: string; sort: string; dir: string; pageSize: number };
  onView: (v: Partial<{ q: string; sort: string; dir: string; pageSize: number }>) => void;
  onTabChange: (t: string) => void;
  onPageChange: (n: number) => void;
}) {
  const s = data?.stats;
  const ins = data?.insights;
  const sent = s?.sent ?? 0;
  const pct = (n: number) => sent > 0 ? `${Math.round((n / sent) * 100)}%` : '0%';
  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
  const bestHour = ins ? ins.opensByHour.indexOf(Math.max(...ins.opensByHour)) : -1;
  const sp = ins?.speed ?? { within1h: 0, within24h: 0, later: 0 };

  return (
    <div className="mb-6" data-campaign-analytics>
      {/* Stat tabs */}
      <div className="mb-5 flex flex-wrap gap-0 overflow-x-auto rounded-lg border bg-card">
        {ANALYTICS_TABS.map((t) => {
          const count = s ? statCount({ stats: s }, t.key) : 0;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onTabChange(t.key)}
              data-analytics-tab={t.key}
              className={`flex flex-col items-start border-r border-border px-5 py-3 text-left transition last:border-r-0 ${active ? 'bg-primary/5 text-primary' : 'hover:bg-elevated text-foreground'}`}
            >
              <span className={`text-lg font-bold tabular-nums leading-none ${active ? 'text-primary' : ''}`}>
                {s ? (t.key === 'overview' ? `${s.audience}` : t.key === 'unopened' ? `${count}` : `${pct(count)}`) : '—'}
              </span>
              <span className="mt-0.5 text-xs text-muted-foreground">
                {t.key !== 'overview' && t.key !== 'unopened' && s ? `(${count}) ` : ''}{t.label}
              </span>
              {active && <span className="mt-1.5 block h-0.5 w-full rounded-full bg-primary" />}
            </button>
          );
        })}
        {loading && <div className="ml-auto flex items-center px-4 text-xs text-muted-foreground">Loading…</div>}
      </div>

      {tab === 'overview' && s && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Audience', value: s.audience, sub: 'Total recipients' },
              { label: 'Sent', value: s.sent, sub: `${pct(s.sent)} of audience` },
              { label: 'Failed', value: s.failed, sub: `${s.failureRate}% failure rate`, warn: s.failed > 0 },
              { label: 'Skipped', value: s.skipped, sub: 'Already sent / no email / condition' },
            ].map((k) => (
              <div key={k.label} className="rounded-lg border bg-card p-4">
                <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{k.label}</div>
                <div className={`text-2xl font-bold tabular-nums ${k.warn ? 'text-destructive' : 'text-foreground'}`}>{k.value}</div>
                <div className="mt-0.5 text-xs text-faint">{k.sub}</div>
              </div>
            ))}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Unique opens', value: s.opens, sub: `${s.openRate}% open rate`, good: s.opens > 0 },
              { label: 'Total opens', value: s.totalOpens, sub: `${s.avgOpensPerOpener || 0} per person who opened`, good: s.totalOpens > 0 },
              { label: 'Clicked', value: s.clicks, sub: `${s.clickRate}% click rate · ${s.totalClicks} clicks in all`, good: s.clicks > 0 },
              { label: 'Replied', value: s.replied, sub: `${s.replyRate}% reply rate`, good: s.replied > 0 },
            ].map((k) => (
              <div key={k.label} className="rounded-lg border bg-card p-4">
                <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{k.label}</div>
                <div className={`text-2xl font-bold tabular-nums ${k.good ? 'text-success' : 'text-foreground'}`}>{k.value}</div>
                <div className="mt-0.5 text-xs text-faint">{k.sub}</div>
              </div>
            ))}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Not opened', value: s.unopened, sub: 'Sent, no open recorded (images blocked also counts)' },
              { label: 'Opened more than once', value: s.repeatOpeners, sub: 'Re-read or forwarded: a sign of interest', good: s.repeatOpeners > 0 },
              { label: 'Click-to-open', value: `${s.clickToOpenRate}%`, sub: 'Of those who opened, who clicked' },
              { label: 'Median time to open', value: fmtDuration(s.medianSecondsToOpen), sub: 'From sending to the first open' },
            ].map((k) => (
              <div key={k.label} className="rounded-lg border bg-card p-4">
                <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{k.label}</div>
                <div className={`text-2xl font-bold tabular-nums ${k.good ? 'text-success' : 'text-foreground'}`}>{k.value}</div>
                <div className="mt-0.5 text-xs text-faint">{k.sub}</div>
              </div>
            ))}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Delivered', value: s.delivered, sub: 'Sent minus bounced' },
              { label: 'Bounced', value: s.bounced, sub: `${s.bounceRate}% bounce rate · added to suppression`, warn: s.bounced > 0 },
              { label: 'Opened within 1 hour', value: sp.within1h, sub: `${sp.within24h} within a day · ${sp.later} later` },
              { label: 'Best hour to open', value: bestHour >= 0 && Math.max(...ins.opensByHour) > 0 ? hours[bestHour] : '—', sub: 'India time' },
            ].map((k) => (
              <div key={k.label} className="rounded-lg border bg-card p-4">
                <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{k.label}</div>
                <div className={`text-2xl font-bold tabular-nums ${k.warn ? 'text-destructive' : 'text-foreground'}`}>{k.value}</div>
                <div className="mt-0.5 text-xs text-faint">{k.sub}</div>
              </div>
            ))}
          </div>
          {data?.trend?.length > 0 && <MiniChart trend={data.trend} />}
          {ins && (
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <Bars title="When people open (hour of day, India time)" values={ins.opensByHour} labels={hours} />
              <Bars title="When people click (hour of day, India time)" values={ins.clicksByHour} labels={hours} color="bg-green-400/70" />
              <Share title="Device" items={ins.devices} empty="No opens recorded yet." />
              <Share title="Mail app / browser" items={ins.clients} empty="No opens recorded yet." />
              <div className="lg:col-span-2"><TopLinks links={ins.topLinks} /></div>
              {ins.clickedWithoutOpen > 0 && (
                <p className="text-xs text-muted-foreground lg:col-span-2">{ins.clickedWithoutOpen} {ins.clickedWithoutOpen === 1 ? 'person clicked' : 'people clicked'} without an open being recorded: their mail app blocks images, so opens are always a minimum, clicks are the surer sign.</p>
              )}
            </div>
          )}
        </>
      )}

      {tab !== 'overview' && (
        <TabRows key={tab} tab={tab as AnalyticsTabKey} tabData={data?.tabData} loading={loading} view={view} onView={onView} page={page} onPage={onPageChange} />
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
