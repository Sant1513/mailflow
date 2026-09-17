'use client';

import { useEffect, useState } from 'react';

interface AnalyticsData {
  totals: {
    sent: number;
    viewed: number;
    signed: number;
    expired: number;
    voided: number;
  };
  signRate: number;
  avgTimeToSignHours: number;
  trend: { day: string; sent: number; signed: number }[];
  recentActivity: {
    id: string;
    title: string;
    recipientName: string;
    recipientEmail: string;
    status: string;
    signedAt: string | null;
    sentAt: string | null;
  }[];
}

const STATUS_BADGE: Record<string, string> = {
  DRAFT: 'badge',
  SENT: 'badge badge-info',
  VIEWED: 'badge badge-warning',
  SIGNED: 'badge badge-success',
  EXPIRED: 'badge',
  VOIDED: 'badge badge-destructive',
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function KpiTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-5 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="text-3xl font-bold text-foreground">{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

function TrendChart({ trend }: { trend: AnalyticsData['trend'] }) {
  const maxVal = Math.max(...trend.map((d) => Math.max(d.sent, d.signed)), 1);
  const chartH = 120;
  const barW = 16;
  const gap = 4;
  const totalW = trend.length * (barW * 2 + gap + 4);

  return (
    <div className="overflow-x-auto">
      <svg width={Math.max(totalW, 600)} height={chartH + 30} className="block">
        {trend.map((d, i) => {
          const x = i * (barW * 2 + gap + 4) + 2;
          const sentH = Math.round((d.sent / maxVal) * chartH);
          const signedH = Math.round((d.signed / maxVal) * chartH);
          const showLabel = i === 0 || i === Math.floor(trend.length / 2) || i === trend.length - 1;
          return (
            <g key={d.day}>
              {/* sent bar (blue) */}
              <rect
                x={x}
                y={chartH - sentH}
                width={barW}
                height={sentH}
                fill="#3b82f6"
                opacity={0.85}
                rx={2}
              />
              {/* signed bar (green) */}
              <rect
                x={x + barW + 2}
                y={chartH - signedH}
                width={barW}
                height={signedH}
                fill="#22c55e"
                opacity={0.85}
                rx={2}
              />
              {showLabel && (
                <text
                  x={x + barW}
                  y={chartH + 18}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#9ca3af"
                >
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-blue-500" /> Sent
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-green-500" /> Signed
        </span>
      </div>
    </div>
  );
}

export default function SigningAnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/e-sign/analytics')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<AnalyticsData>;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  const avgDays =
    data !== null ? Math.round((data.avgTimeToSignHours / 24) * 10) / 10 : null;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold text-foreground">Signing Analytics</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          Failed to load analytics: {error}
        </div>
      )}

      {!data && !error && (
        <p className="text-muted-foreground">Loading...</p>
      )}

      {data && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            <KpiTile label="Total Sent" value={String(data.totals.sent)} />
            <KpiTile label="Viewed" value={String(data.totals.viewed)} />
            <KpiTile label="Signed" value={String(data.totals.signed)} />
            <KpiTile label="Sign Rate" value={`${data.signRate}%`} sub="of sent" />
            <KpiTile
              label="Avg Time to Sign"
              value={avgDays !== null ? `${avgDays} days` : '—'}
            />
          </div>

          {/* Trend chart */}
          <div className="bg-card border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">30-Day Trend</h2>
            <TrendChart trend={data.trend} />
          </div>

          {/* Recent activity */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-lg font-semibold text-foreground">Recent Activity</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Recipient</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Sent</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Signed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.recentActivity.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-3 text-foreground font-medium truncate max-w-[200px]">{r.title}</td>
                      <td className="px-4 py-3">
                        <div className="text-foreground">{r.recipientName}</div>
                        <div className="text-muted-foreground text-xs">{r.recipientEmail}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={STATUS_BADGE[r.status] ?? 'badge'}>
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{fmt(r.sentAt)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{fmt(r.signedAt)}</td>
                    </tr>
                  ))}
                  {data.recentActivity.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                        No signing requests yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
