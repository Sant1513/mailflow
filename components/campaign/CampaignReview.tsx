'use client';

import { useState } from 'react';
import { EmailPreview } from '@/components/email-preview/EmailPreview';
import { HealthCheckPanel, type HealthCheckResult } from '@/components/email-editor/HealthCheckPanel';

const REASON_LABELS: Record<string, string> = {
  ALREADY_SENT: 'Already sent',
  INVALID_EMAIL: 'Invalid email',
  MISSING_EMAIL: 'No email address',
  MISSING_VARIABLE: 'Missing variable value',
  DUPLICATE_IN_BATCH: 'Duplicate address',
  CONDITION_NOT_MET: 'Condition not met',
  FREQUENCY_LIMIT: 'Send-frequency limit',
  MANUALLY_SKIPPED: 'Excluded',
};

export interface CampaignPreview {
  headers: {
    fromName: string;
    fromEmail: string | null;
    replyTo: string | null;
    cc: string[];
    bcc: string[];
    senderStatus: string | null;
  };
  summary: {
    total: number;
    wouldSend: number;
    skipped: number;
    invalid: number;
    byReason: Record<string, number>;
    ccPerMessage: number;
    bccPerMessage: number;
    totalDeliveries: number;
  };
  recipients: {
    recordId: string;
    email: string | null;
    willSend: boolean;
    skipReason: string | null;
    reasonDetail: string;
    data: Record<string, unknown>;
  }[];
  recipientsTruncated: boolean;
  preview: {
    recordId: string;
    subject: string;
    html: string;
    plainText: string | null;
    missingVariables: string[];
    resolved: Record<string, string>;
  } | null;
  templateCheck: {
    variablesUsed: string[];
    variablesMissing: string[];
    columnsUnused: string[];
    ok: boolean;
  };
  health: HealthCheckResult;
  campaign: { templateVersion: number; template: { name: string }; dataset: { name: string } };
}

/** §113: the pre-send review — who, what, and what's wrong, before sending. */
export function CampaignReview({
  data,
  onSelectRecipient,
  loadingRecipient,
}: {
  data: CampaignPreview;
  onSelectRecipient: (recordId: string) => void;
  loadingRecipient: boolean;
}) {
  const [mode, setMode] = useState<'desktop' | 'mobile'>('desktop');
  const [showAll, setShowAll] = useState(false);
  const [showHealth, setShowHealth] = useState(false);

  const visible = showAll ? data.recipients : data.recipients.slice(0, 12);
  // The address already has its own column, so drop whichever data field
  // holds it — otherwise it renders twice under two different headings.
  const firstRow = data.recipients[0];
  const columns = Object.keys(firstRow?.data ?? {})
    .filter((key) => {
      const value = firstRow?.data[key];
      return !(typeof value === 'string' && firstRow?.email && value.trim().toLowerCase() === firstRow.email.toLowerCase());
    })
    .slice(0, 5);

  return (
    <div className="space-y-4">
      {/* Volume summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Recipients evaluated" value={data.summary.total} />
        <Stat label="Will receive" value={data.summary.wouldSend} tone="good" />
        <Stat label="Skipped" value={data.summary.skipped} />
        <Stat
          label="Invalid"
          value={data.summary.invalid}
          tone={data.summary.invalid > 0 ? 'bad' : undefined}
        />
      </div>

      {(data.summary.ccPerMessage > 0 || data.summary.bccPerMessage > 0) && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          CC/BCC are on every message. {data.summary.wouldSend} recipients ×{' '}
          {1 + data.summary.ccPerMessage + data.summary.bccPerMessage} copies ={' '}
          <strong>{data.summary.totalDeliveries} total emails</strong>.
        </div>
      )}

      {/* Exact headers */}
      <div className="rounded-lg border bg-card p-4 text-sm">
        <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          Headers every message will carry
        </h3>
        <dl className="grid gap-1 text-xs sm:grid-cols-2">
          <Row label="From" value={`${data.headers.fromName} <${data.headers.fromEmail ?? 'not connected'}>`} />
          <Row label="Reply-To" value={data.headers.replyTo ?? '(same as From)'} />
          <Row label="CC" value={data.headers.cc.length ? data.headers.cc.join(', ') : '—'} />
          <Row label="BCC" value={data.headers.bcc.length ? data.headers.bcc.join(', ') : '—'} />
          <Row label="Template" value={`${data.campaign.template.name} v${data.campaign.templateVersion}`} />
          <Row label="Dataset" value={data.campaign.dataset.name} />
        </dl>
      </div>

      {/* Template cross-check */}
      <div className="rounded-lg border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Template check</h3>
          <button onClick={() => setShowHealth((s) => !s)} className="text-xs text-primary hover:underline">
            {showHealth ? 'Hide' : 'Show'} full health check
          </button>
        </div>
        <div className="space-y-1 text-xs">
          <div>
            <span className="text-muted-foreground">Variables used: </span>
            {data.templateCheck.variablesUsed.length
              ? data.templateCheck.variablesUsed.map((v) => `{{${v}}}`).join(', ')
              : 'none'}
          </div>
          {data.templateCheck.variablesMissing.length > 0 ? (
            <div className="text-primary">
              ✕ Missing from dataset:{' '}
              {data.templateCheck.variablesMissing.map((v) => `{{${v}}}`).join(', ')} — sending is blocked.
            </div>
          ) : (
            <div className="text-success">✓ Every variable exists in the dataset.</div>
          )}
          {data.templateCheck.columnsUnused.length > 0 && (
            <div className="text-muted-foreground">
              Unused columns: {data.templateCheck.columnsUnused.join(', ')}
            </div>
          )}
        </div>
        {showHealth && (
          <div className="mt-3">
            <HealthCheckPanel result={data.health} onClose={() => setShowHealth(false)} />
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Recipient list */}
        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
            Who receives this
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="px-2 py-1 text-left">Email</th>
                  {columns.map((c) => (
                    <th key={c} className="px-2 py-1 text-left">{c}</th>
                  ))}
                  <th className="px-2 py-1 text-left">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.recordId}
                    onClick={() => r.willSend && onSelectRecipient(r.recordId)}
                    className={`border-t ${
                      r.willSend ? 'cursor-pointer hover:bg-elevated/60' : 'bg-destructive/10'
                    } ${data.preview?.recordId === r.recordId ? 'bg-primary/10' : ''}`}
                    title={r.willSend ? 'Click to preview this person\'s email' : r.reasonDetail}
                  >
                    <td className="px-2 py-1">{r.email ?? '—'}</td>
                    {columns.map((c) => (
                      <td key={c} className="px-2 py-1 text-muted-foreground">
                        {String(r.data[c] ?? '')}
                      </td>
                    ))}
                    <td className={`px-2 py-1 ${r.willSend ? 'text-success' : 'text-primary'}`}>
                      {r.willSend ? 'Will send' : REASON_LABELS[r.skipReason ?? ''] ?? 'Skipped'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.recipients.length > 12 && (
            <button
              onClick={() => setShowAll((s) => !s)}
              className="w-full border-t px-4 py-2 text-xs text-primary hover:bg-elevated"
            >
              {showAll ? 'Show fewer' : `Show all ${data.recipients.length}`}
              {data.recipientsTruncated && !showAll ? ' (first page)' : ''}
            </button>
          )}
        </div>

        {/* Rendered email for the selected recipient */}
        <div className="flex flex-col rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <div className="min-w-0 text-xs">
              <span className="text-muted-foreground">Subject: </span>
              <span className="font-medium">{data.preview?.subject ?? '—'}</span>
            </div>
            <div className="flex gap-1">
              {(['desktop', 'mobile'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded px-2 py-1 text-xs ${
                    mode === m ? 'bg-muted font-medium' : 'text-muted-foreground'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {data.preview ? (
            <>
              {data.preview.missingVariables.length > 0 && (
                <div className="border-b bg-warning/10 px-4 py-2 text-xs text-warning">
                  Unresolved for this person:{' '}
                  {data.preview.missingVariables.map((v) => `{{${v}}}`).join(', ')}
                </div>
              )}
              <div className={`min-h-[300px] flex-1 ${loadingRecipient ? 'opacity-50' : ''}`}>
                <EmailPreview html={data.preview.html} mode={mode} />
              </div>
              {Object.keys(data.preview.resolved).length > 0 && (
                <details className="border-t px-4 py-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Resolved values for this recipient
                  </summary>
                  <dl className="mt-1 space-y-0.5 text-[11px]">
                    {Object.entries(data.preview.resolved).map(([k, v]) => (
                      <div key={k} className="flex gap-1">
                        <dt className="font-mono text-muted-foreground">{`{{${k}}}`}</dt>
                        <dd className="truncate">
                          → {v || <span className="italic text-warning">empty</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              No sendable recipient to preview.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt className="shrink-0 text-muted-foreground">{label}:</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  const color = tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-primary' : '';
  return (
    <div className="rounded border bg-card p-2">
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
