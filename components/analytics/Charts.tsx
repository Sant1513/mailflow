'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DayPoint, FailureRatePoint } from '@/lib/analytics/series';

// Chart colours come from the same tokens as the rest of the UI so the
// charts follow the Masai palette without a second colour system.
const C = {
  primary: 'hsl(348 97% 47%)',
  info: 'hsl(213 94% 68%)',
  warning: 'hsl(43 96% 56%)',
  grid: 'hsl(240 4% 16%)',
  axis: 'hsl(240 4% 46%)',
  tooltipBg: 'hsl(240 6% 13%)',
  tooltipBorder: 'hsl(240 4% 16%)',
  text: 'hsl(60 5% 96%)',
};

function shortDay(day: string) {
  // "2026-09-05" -> "5 Sep"
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const tooltipStyle = {
  contentStyle: {
    background: C.tooltipBg,
    border: `1px solid ${C.tooltipBorder}`,
    borderRadius: 8,
    fontSize: 12,
    color: C.text,
  },
  labelStyle: { color: C.text, fontWeight: 600 },
  itemStyle: { color: C.text },
};

const axisProps = {
  tick: { fill: C.axis, fontSize: 11 },
  axisLine: { stroke: C.grid },
  tickLine: false as const,
};

export function DailyAreaChart({
  series,
  label,
  color = 'primary',
  height = 220,
}: {
  series: DayPoint[];
  label: string;
  color?: 'primary' | 'info';
  height?: number;
}) {
  const stroke = color === 'info' ? C.info : C.primary;
  const id = `fill-${color}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={series} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="day" tickFormatter={shortDay} minTickGap={24} {...axisProps} />
        <YAxis allowDecimals={false} {...axisProps} />
        <Tooltip {...tooltipStyle} labelFormatter={(d) => shortDay(String(d))} formatter={(v) => [v, label]} />
        <Area type="monotone" dataKey="value" name={label} stroke={stroke} strokeWidth={2} fill={`url(#${id})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function FailureRateChart({ series, height = 220 }: { series: FailureRatePoint[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={series} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="day" tickFormatter={shortDay} minTickGap={24} {...axisProps} />
        <YAxis domain={[0, 100]} unit="%" {...axisProps} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(d) => shortDay(String(d))}
          formatter={(v, _n, item) => {
            const p = item.payload as FailureRatePoint;
            return [`${v ?? '—'}% (${p.failed} failed / ${p.sent + p.failed} attempted)`, 'Failure rate'];
          }}
        />
        <Bar dataKey="ratePct" name="Failure rate" fill={C.warning} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
