'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Archive, ArrowRight, Bell, CalendarClock, Cpu, Link2, Mail, MessageSquareText, PenLine, Server, Timer, UserRound, Users, Webhook, type LucideIcon } from 'lucide-react';

/** Icons by name: the page is rendered on the server, and components can't be passed across. */
const ICONS: Record<string, LucideIcon> = { profile: UserRound, signature: PenLine, replies: MessageSquareText, sharing: Users, gmail: Mail, sla: Timer, server: Server, webhooks: Webhook, slack: Bell, link: Link2, retention: Archive, automation: CalendarClock, runtime: Cpu };
export type SettingsIcon = keyof typeof ICONS;
const iconFor = (name: string) => ICONS[name] ?? Link2;

export interface SettingsSection {
  id: string;
  label: string;
  icon: string;
  group: string;
}

/**
 * Settings, laid out like the app: a sticky section menu on the left in the sidebar's style
 * (group labels, icons, the sliding red pill on the section in view) and the cards on the right.
 * On phones the menu becomes a row of chips that scrolls sideways.
 */
export function SettingsLayout({ sections, children }: { sections: SettingsSection[]; children: ReactNode }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');

  // The section in view lights up in the menu.
  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e);
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        const best = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
        if (best && best[1] > 0) setActive(best[0]);
      },
      { threshold: [0, 0.2, 0.5, 0.8], rootMargin: '-80px 0px -40% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sections]);

  const go = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const groups = [...new Set(sections.map((s) => s.group))];

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      {/* Desktop: the sidebar-style menu. */}
      <nav aria-label="Settings sections" className="glass-nav sticky top-4 hidden rounded-[var(--radius-card)] p-2 lg:block">
        {groups.map((g) => (
          <div key={g} className="mb-1.5 last:mb-0">
            <div className="px-3 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{g}</div>
            {sections.filter((s) => s.group === g).map((s) => {
              const on = active === s.id;
              const Icon = iconFor(s.icon);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => go(s.id)}
                  aria-current={on ? 'true' : undefined}
                  className={`group relative flex min-h-[38px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm ${on ? 'font-medium text-white' : 'text-muted-foreground hover:bg-elevated hover:text-foreground'}`}
                >
                  {on && <motion.span layoutId="settings-pill" className="nav-pill absolute inset-0 rounded-xl" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}
                  <Icon size={17} strokeWidth={on ? 2.2 : 1.8} className="relative shrink-0 transition-transform duration-200 group-hover:scale-110" />
                  <span className="relative truncate">{s.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="min-w-0 space-y-6">
        {/* Phones and tablets: the sections as chips. */}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden">
          {sections.map((s) => (
            <button key={s.id} type="button" onClick={() => go(s.id)} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${active === s.id ? 'nav-pill border-transparent text-white' : 'border-border text-muted-foreground'}`}>
              {s.label}
            </button>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A group heading in the content, in the sidebar's label style. */
export function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{label}</div>
      {children}
    </section>
  );
}

/** One settings card: an icon chip, title and description, then its content. */
export function SettingsCard({ id, icon, title, description, children, className = '' }: { id: string; icon: string; title: string; description?: ReactNode; children?: ReactNode; className?: string }) {
  const Icon = iconFor(icon);
  return (
    <section id={id} className={`panel scroll-mt-6 p-5 ${className}`}>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
          <Icon size={17} strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <h2 className="font-heading text-[15px] font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

/** A card that opens another settings page (SLA, server, webhooks). */
export function SettingsLinkCard({ id, icon, title, description, href, cta }: { id: string; icon: string; title: string; description: string; href: string; cta: string }) {
  const Icon = iconFor(icon);
  return (
    <Link id={id} href={href} className="panel lift group flex scroll-mt-6 items-start gap-3 p-5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
        <Icon size={17} strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-heading text-[15px] font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>
        <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary">
          {cta} <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </span>
    </Link>
  );
}
