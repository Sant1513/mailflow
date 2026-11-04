'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BellRing,
  CheckCheck,
  Clock,
  Database,
  Eye,
  Hourglass,
  Inbox,
  Mail,
  MailX,
  Megaphone,
  MessageSquareReply,
  MousePointerClick,
  Percent,
  PenLine,
  Send,
  Timer,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { CountUp, EASE } from '@/components/motion/Motion';

/** Icons by name, so server components can choose them (functions can't cross to the client). */
const ICONS: Record<string, LucideIcon> = {
  mail: Mail,
  send: Send,
  reply: MessageSquareReply,
  percent: Percent,
  alert: AlertTriangle,
  hourglass: Hourglass,
  inbox: Inbox,
  check: CheckCheck,
  bell: BellRing,
  eye: Eye,
  click: MousePointerClick,
  unsub: MailX,
  clock: Clock,
  timer: Timer,
  database: Database,
  pen: PenLine,
  megaphone: Megaphone,
  workflow: Workflow,
  zap: Zap,
};
export type IconName = keyof typeof ICONS;

/** "Good morning / afternoon / evening" by the viewer's own clock. */
export function Greeting({ name }: { name: string }) {
  const [part, setPart] = useState('Hello');
  useEffect(() => {
    const h = new Date().getHours();
    setPart(h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening');
  }, []);
  return (
    <h1 className="font-heading text-[26px] font-bold tracking-tight text-foreground sm:text-3xl">
      {part}, {name}
    </h1>
  );
}

export function ChangePill({ pct, invert = false }: { pct: number | null; invert?: boolean }) {
  if (pct === null) return null;
  const good = invert ? pct <= 0 : pct >= 0;
  const Icon = pct >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${good ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'}`}>
      <Icon size={11} />
      {Math.abs(pct)}%
    </span>
  );
}

/** The highlighted card: gradient, the period's sent count, its change and two shortcuts. */
export function HeroCard({ label, value, pct, rows, actions }: { label: string; value: string; pct: number | null; rows: { label: string; value: string }[]; actions: { href: string; label: string; icon: IconName }[] }) {
  return (
    <div className="relative h-full overflow-hidden rounded-[var(--radius-card)] bg-gradient-to-br from-accent-from to-accent-to p-5 text-white shadow-lift">
      {/* Soft light blobs, like the reference's glossy highlight card. */}
      <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-white/20 blur-2xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-10 h-56 w-56 rounded-full bg-black/10 blur-2xl" />
      <div className="relative">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white/85">{label}</span>
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/20 backdrop-blur"><Send size={15} /></span>
        </div>
        <div className="mt-2 font-heading text-4xl font-bold tracking-tight">
          <CountUp value={value} />
        </div>
        <div className="mt-1 flex min-h-[20px] items-center gap-1.5 text-xs text-white/85">
          {pct === null ? <span>Nothing to compare with yet</span> : (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-white/25 px-1.5 py-0.5 font-semibold text-white">
              {pct >= 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
              {Math.abs(pct)}%
            </span>
          )}
          {pct !== null && <span>than the period before</span>}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {rows.map((r) => (
            <div key={r.label} className="rounded-xl bg-white/15 px-3 py-2 backdrop-blur">
              <div className="text-[11px] text-white/80">{r.label}</div>
              <div className="font-heading text-lg font-semibold"><CountUp value={r.value} /></div>
            </div>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {actions.map((a, i) => {
            const Icon = ICONS[a.icon] ?? Mail;
            return (
              <Link key={a.href} href={a.href} className={`flex items-center justify-center gap-1.5 rounded-full px-3 py-2 text-sm font-semibold transition hover:-translate-y-0.5 active:scale-[0.98] ${i === 0 ? 'bg-white text-[hsl(240_10%_9%)]' : 'bg-white/20 text-white hover:bg-white/30'}`}>
                <Icon size={15} /> {a.label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** KPI card: icon chip, counted-up number, label, a short note and an optional change pill. */
export function StatCard({ icon, label, value, note, pct, tone, href, invert }: { icon: IconName; label: string; value: string; note?: string; pct?: number | null; tone?: 'warn' | 'good'; href?: string; invert?: boolean }) {
  const Icon = ICONS[icon] ?? Mail;
  const body = (
    <div className="panel lift flex h-full flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone === 'warn' ? 'bg-warning/15 text-warning' : tone === 'good' ? 'bg-success/15 text-success' : 'bg-muted text-foreground'}`}>
          <Icon size={17} />
        </span>
        {pct !== undefined && <ChangePill pct={pct} invert={invert} />}
      </div>
      <div className={`mt-3 font-heading text-2xl font-bold tracking-tight ${tone === 'warn' ? 'text-warning' : 'text-foreground'}`}>
        <CountUp value={value} />
      </div>
      <div className="mt-0.5 text-sm font-medium text-foreground">{label}</div>
      {note && <div className="mt-0.5 text-xs text-faint">{note}</div>}
    </div>
  );
  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}

const fmtDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** Rounded bars that grow from the baseline; the latest bar is highlighted. Weeks when the window is long. */
export function BarTrend({ points, height = 220 }: { points: { day: string; value: number }[]; height?: number }) {
  const weekly = points.length > 14;
  const data = weekly
    ? Array.from({ length: Math.ceil(points.length / 7) }, (_, i) => {
        const chunk = points.slice(i * 7, i * 7 + 7);
        return { label: `${fmtDay(chunk[0]!.day)}`, value: chunk.reduce((n, p) => n + p.value, 0) };
      })
    : points.map((p) => ({ label: new Date(`${p.day}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' }), value: p.value }));
  const last = data.length - 1;
  const empty = data.every((d) => !d.value);
  return (
    <div className="relative" style={{ height }}>
      {empty && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <span className="rounded-full border border-border-subtle bg-card px-3 py-1.5 text-xs text-faint shadow-card">No emails sent in this period yet</span>
        </div>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 18, right: 4, left: -18, bottom: 0 }} barCategoryGap="22%">
          <XAxis dataKey="label" tick={{ fill: 'hsl(var(--faint))', fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fill: 'hsl(var(--faint))', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
          <Tooltip
            cursor={{ fill: 'hsl(var(--elevated))', radius: 10 } as never}
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12, color: 'hsl(var(--foreground))', boxShadow: 'var(--shadow-card)' }}
            formatter={(v: number) => [v.toLocaleString('en-IN'), weekly ? 'Sent that week' : 'Sent']}
          />
          <Bar dataKey="value" radius={[10, 10, 10, 10]} animationDuration={900} animationEasing="ease-out">
            {data.map((_, i) => (
              <Cell key={i} fill={i === last ? 'url(#bar-hot)' : 'hsl(var(--primary) / 0.22)'} />
            ))}
          </Bar>
          <defs>
            <linearGradient id="bar-hot" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--accent-to))" />
              <stop offset="100%" stopColor="hsl(var(--accent-from))" />
            </linearGradient>
          </defs>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Donut with the total counted up in the middle and a legend underneath. */
export function Donut({ slices, centerLabel }: { slices: { label: string; value: number; color: string }[]; centerLabel: string }) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const data = total ? slices : [{ label: 'Nothing yet', value: 1, color: 'hsl(var(--muted))' }];
  return (
    <div>
      <div className="relative mx-auto h-44 w-44">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="label" innerRadius="70%" outerRadius="100%" paddingAngle={total ? 3 : 0} cornerRadius={8} stroke="none" animationDuration={1000} startAngle={90} endAngle={-270}>
              {data.map((s) => <Cell key={s.label} fill={s.color} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-heading text-2xl font-bold text-foreground"><CountUp value={total.toLocaleString('en-IN')} /></span>
          <span className="text-[11px] text-faint">{centerLabel}</span>
        </div>
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} /><span className="truncate">{s.label}</span></span>
            <span className="font-semibold text-foreground">{s.value.toLocaleString('en-IN')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A shortcut row: icon chip, title and note, with an arrow that slides on hover. */
export function QuickAction({ href, label, desc, icon }: { href: string; label: string; desc: string; icon: IconName }) {
  const Icon = ICONS[icon] ?? Mail;
  return (
    <motion.div className="min-w-0" whileHover={{ x: 3 }} transition={{ duration: 0.2, ease: EASE }}>
      <Link href={href} className="group flex items-center gap-3 rounded-xl border border-border-subtle bg-muted/60 px-3 py-2.5 hover:border-border hover:bg-elevated">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-card text-foreground shadow-card"><Icon size={16} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          <span className="block truncate text-xs text-faint">{desc}</span>
        </span>
        <ArrowRight size={15} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </Link>
    </motion.div>
  );
}
