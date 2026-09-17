'use client';

import { useEffect, useState, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WeekPoint {
  week: string;
  sent: number;
  signed: number;
}

interface ReportData {
  period: { from: string; to: string };
  signing: {
    sent: number;
    signed: number;
    signRate: number;
    avgTimeToSignHours: number;
    pendingCount: number;
    expiredCount: number;
    byWeek: WeekPoint[];
  };
  campaigns: {
    total: number;
    emailsSent: number;
    openRate: number;
    clickRate: number;
    failureRate: number;
  };
  inbox: {
    totalConversations: number;
    openCount: number;
    resolvedCount: number;
    resolutionRate: number;
  };
}

// ─── KPI Tile ─────────────────────────────────────────────────────────────────

function KpiTile({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="font-heading text-2xl font-bold text-foreground">{value}</div>
      <div className="mt-0.5 text-sm font-medium text-foreground">{title}</div>
      {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
    </div>
  );
}

function SkeletonTile() {
  return (
    <div className="animate-pulse rounded-lg border border-border bg-card p-4 opacity-50">
      <div className="h-8 w-16 rounded bg-muted" />
      <div className="mt-2 h-4 w-24 rounded bg-muted" />
    </div>
  );
}

// ─── SVG Bar Chart ────────────────────────────────────────────────────────────

const CHART_LEFT = 40;
const CHART_TOP = 10;
const CHART_BOTTOM = 35;
const CHART_MAX_BAR_H = 140;
const CHART_TOTAL_W = 600;
const CHART_TOTAL_H = 200;
const CHART_W = CHART_TOTAL_W - CHART_LEFT - 10;
const CHART_H = CHART_TOTAL_H - CHART_TOP - CHART_BOTTOM; // 155

function WeeklyBarChart({ data }: { data: WeekPoint[] }) {
  if (data.length === 0) return null;

  const maxValue = Math.max(...data.map((d) => Math.max(d.sent, d.signed)), 1);
  const weekCount = data.length;
  const weekWidth = CHART_W / weekCount;
  const barWidth = Math.floor((weekWidth - 6) * 0.45);
  const barGap = 3;
  const baseline = CHART_TOP + CHART_H; // y-coordinate of x-axis

  return (
    <svg
      viewBox={`0 0 ${CHART_TOTAL_W} ${CHART_TOTAL_H}`}
      xmlns="http://www.w3.org/2000/svg"
      className="w-full"
      role="img"
      aria-label="Weekly signing trend chart"
    >
      {/* Y-axis grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const y = CHART_TOP + CHART_H - fraction * CHART_MAX_BAR_H;
        const label = Math.round(fraction * maxValue);
        return (
          <g key={fraction}>
            <line
              x1={CHART_LEFT}
              y1={y}
              x2={CHART_TOTAL_W - 10}
              y2={y}
              stroke="currentColor"
              strokeOpacity="0.1"
              strokeWidth="1"
            />
            <text
              x={CHART_LEFT - 4}
              y={y + 4}
              textAnchor="end"
              fontSize="9"
              fill="currentColor"
              opacity="0.5"
            >
              {label}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {data.map((d, i) => {
        const weekX = CHART_LEFT + i * weekWidth;
        const centerX = weekX + weekWidth / 2;
        const sentH = maxValue > 0 ? Math.round((d.sent / maxValue) * CHART_MAX_BAR_H) : 0;
        const signedH = maxValue > 0 ? Math.round((d.signed / maxValue) * CHART_MAX_BAR_H) : 0;

        const sentX = centerX - barWidth - barGap / 2;
        const signedX = centerX + barGap / 2;

        return (
          <g key={d.week}>
            {/* Sent bar (steel blue) */}
            <rect
              x={sentX}
              y={baseline - sentH}
              width={barWidth}
              height={Math.max(sentH, 1)}
              fill="#4682b4"
              rx="2"
              ry="2"
            />
            {/* Signed bar (green) */}
            <rect
              x={signedX}
              y={baseline - signedH}
              width={barWidth}
              height={Math.max(signedH, 1)}
              fill="#22c55e"
              rx="2"
              ry="2"
            />
            {/* X-axis label */}
            <text
              x={centerX}
              y={baseline + 16}
              textAnchor="middle"
              fontSize="9"
              fill="currentColor"
              opacity="0.6"
            >
              {d.week}
            </text>
          </g>
        );
      })}

      {/* X baseline */}
      <line
        x1={CHART_LEFT}
        y1={baseline}
        x2={CHART_TOTAL_W - 10}
        y2={baseline}
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="1"
      />

      {/* Legend */}
      <g>
        <rect x={CHART_LEFT} y={CHART_TOTAL_H - 12} width={8} height={8} fill="#4682b4" rx="1" />
        <text x={CHART_LEFT + 11} y={CHART_TOTAL_H - 4} fontSize="9" fill="currentColor" opacity="0.7">
          Sent
        </text>
        <rect x={CHART_LEFT + 45} y={CHART_TOTAL_H - 12} width={8} height={8} fill="#22c55e" rx="1" />
        <text x={CHART_LEFT + 56} y={CHART_TOTAL_H - 4} fontSize="9" fill="currentColor" opacity="0.7">
          Signed
        </text>
      </g>
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDateInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function preset(days: number): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: toDateInput(from), to: toDateInput(now) };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const initial = preset(30);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (fromDate: string, toDate: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports?from=${fromDate}&to=${toDate}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(from, to);
  }, [from, to, fetchData]);

  function applyPreset(days: number) {
    const p = preset(days);
    setFrom(p.from);
    setTo(p.to);
  }

  const exportUrl = `/api/reports/export?from=${from}&to=${to}`;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">Workspace</div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">Reports</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Preset buttons */}
          <div className="flex items-center gap-1">
            {[7, 30, 90].map((days) => (
              <button
                key={days}
                onClick={() => applyPreset(days)}
                className="btn-secondary !py-1.5 text-xs"
              >
                {days}d
              </button>
            ))}
          </div>

          {/* Date range pickers */}
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            value={to}
            min={from}
            max={toDateInput(new Date())}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground"
          />

          {/* Export */}
          <a
            href={exportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary !py-1.5 text-xs"
          >
            Export CSV
          </a>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load report: {error}
        </div>
      )}

      {/* ── Section 1: Document Signing ──────────────────────────────────── */}
      <div className="mb-8">
        <h2 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Document Signing
        </h2>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => <SkeletonTile key={i} />)
          ) : data ? (
            <>
              <KpiTile title="Documents Sent" value={data.signing.sent} />
              <KpiTile title="Signed" value={data.signing.signed} subtitle={`${data.signing.pendingCount} pending · ${data.signing.expiredCount} expired`} />
              <KpiTile title="Sign Rate" value={`${data.signing.signRate}%`} />
              <KpiTile
                title="Avg Time to Sign"
                value={data.signing.avgTimeToSignHours > 0 ? `${data.signing.avgTimeToSignHours}h` : '—'}
                subtitle="hours from sent to signed"
              />
            </>
          ) : null}
        </div>

        {/* Weekly trend chart */}
        {!loading && data && data.signing.byWeek.length > 0 && (
          <div className="mt-4 rounded-lg border border-border bg-card p-4">
            <div className="mb-2 font-heading text-sm font-semibold">Weekly signing trend · last 8 weeks</div>
            <WeeklyBarChart data={data.signing.byWeek} />
          </div>
        )}
      </div>

      {/* ── Section 2: Campaigns ─────────────────────────────────────────── */}
      <div className="mb-8">
        <h2 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Campaigns
        </h2>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => <SkeletonTile key={i} />)
          ) : data ? (
            <>
              <KpiTile title="Emails Sent" value={data.campaigns.emailsSent.toLocaleString('en-IN')} subtitle={`${data.campaigns.total} campaign${data.campaigns.total === 1 ? '' : 's'}`} />
              <KpiTile title="Open Rate" value={`${data.campaigns.openRate}%`} />
              <KpiTile title="Click Rate" value={`${data.campaigns.clickRate}%`} subtitle={data.campaigns.failureRate > 0 ? `${data.campaigns.failureRate}% failure rate` : undefined} />
            </>
          ) : null}
        </div>
      </div>

      {/* ── Section 3: Inbox ─────────────────────────────────────────────── */}
      <div className="mb-8">
        <h2 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Inbox
        </h2>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => <SkeletonTile key={i} />)
          ) : data ? (
            <>
              <KpiTile title="Total Conversations" value={data.inbox.totalConversations} />
              <KpiTile title="Open" value={data.inbox.openCount} />
              <KpiTile title="Resolution Rate" value={`${data.inbox.resolutionRate}%`} subtitle={`${data.inbox.resolvedCount} resolved`} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
