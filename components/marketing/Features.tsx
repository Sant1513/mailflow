'use client';

import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  BarChart3,
  Braces,
  FileSignature,
  FileText,
  FileUp,
  Inbox,
  BellRing,
  Rocket,
  Sheet,
  Users,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';

const EASE_OUT = [0.22, 0.61, 0.36, 1] as const;

type Product = 'mail' | 'sign';
type Tile = { icon: LucideIcon; title: string; body: string; span?: string; art?: React.ReactNode };

/* ---------- Tiny illustrations (play once when first seen; static with reduced motion) ---------- */

function useOnce() {
  const reduce = useReducedMotion();
  return {
    reduce,
    view: { once: true, amount: 0.5 } as const,
    t: (delay = 0, duration = 0.6) => (reduce ? { duration: 0 } : { duration, delay, ease: EASE_OUT }),
  };
}

function CampaignArt() {
  const { view, t } = useOnce();
  const steps = ['Preview', 'Dry run', 'Approved', 'Sending'];
  return (
    <div aria-hidden className="mt-5 rounded-xl border border-border-subtle bg-background/60 p-3">
      <div className="flex flex-wrap gap-1.5">
        {steps.map((s, i) => (
          <motion.span
            key={s}
            className={`badge ${i === steps.length - 1 ? 'badge-danger' : 'badge-success'}`}
            initial={{ opacity: 0, y: 6 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={view}
            transition={t(0.15 + i * 0.12, 0.35)}
          >
            {i < steps.length - 1 ? '✓ ' : ''}
            {s}
          </motion.span>
        ))}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <motion.div
          className="h-full w-full origin-left rounded-full bg-gradient-to-r from-accent-from to-accent-to"
          initial={{ scaleX: 0 }}
          whileInView={{ scaleX: 0.72 }}
          viewport={view}
          transition={t(0.6, 1.2)}
        />
      </div>
    </div>
  );
}

function InboxArt() {
  const { view, t } = useOnce();
  const rows = [
    { tag: 'Interested', tone: 'badge-success', line: 'AI draft ready · approve to send' },
    { tag: 'Question', tone: 'badge-warning', line: 'Assigned to you · SLA 2h left' },
    { tag: 'Out of office', tone: 'badge-neutral', line: 'Follow-up reminder set' },
  ];
  return (
    <ul aria-hidden className="mt-5 grid gap-1.5">
      {rows.map((r, i) => (
        <motion.li
          key={r.tag}
          className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-background/60 px-2.5 py-2 text-[11px] text-muted-foreground"
          initial={{ opacity: 0, x: 14 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={view}
          transition={t(0.15 + i * 0.12, 0.4)}
        >
          <span className="truncate">{r.line}</span>
          <span className={`badge shrink-0 ${r.tone}`}>{r.tag}</span>
        </motion.li>
      ))}
    </ul>
  );
}

function TokenArt() {
  const { view, t } = useOnce();
  return (
    <div aria-hidden className="mt-4 rounded-lg border border-border-subtle bg-background/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
      Hi{' '}
      <motion.span
        className="rounded bg-primary/10 px-1 text-primary"
        initial={{ opacity: 0.4 }}
        whileInView={{ opacity: 1 }}
        viewport={view}
        transition={t(0.2, 0.5)}
      >
        {'{{First name | there}}'}
      </motion.span>
      ,
    </div>
  );
}

function ReportArt() {
  const { view, t } = useOnce();
  const bars = [0.45, 0.7, 0.55, 0.9, 0.65, 0.8, 0.5, 0.95, 0.75, 0.6, 0.85, 0.7];
  return (
    <div aria-hidden className="mt-5 flex h-16 items-end gap-1.5 sm:gap-2">
      {bars.map((h, i) => (
        <motion.span
          key={i}
          className={`h-full flex-1 origin-bottom rounded-t ${i === 7 ? 'bg-primary' : 'bg-primary/25'}`}
          initial={{ scaleY: 0.08 }}
          whileInView={{ scaleY: h }}
          viewport={view}
          transition={t(0.1 + i * 0.04, 0.5)}
        />
      ))}
    </div>
  );
}

function SignOrderArt() {
  const { view, t } = useOnce();
  const signers = ['Student', 'Guardian', 'Masai'];
  return (
    <ol aria-hidden className="mt-5 flex items-center gap-2">
      {signers.map((s, i) => (
        <li key={s} className="flex min-w-0 flex-1 items-center gap-2">
          <motion.span
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border-subtle bg-background/60 px-2 py-2 text-[11px] text-muted-foreground"
            initial={{ opacity: 0.35 }}
            whileInView={{ opacity: 1 }}
            viewport={view}
            transition={t(0.2 + i * 0.35, 0.4)}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-[9px] font-semibold text-success">{i + 1}</span>
            <span className="truncate">{s}</span>
          </motion.span>
          {i < signers.length - 1 && <span className="text-faint">→</span>}
        </li>
      ))}
    </ol>
  );
}

function WriteBackArt() {
  const { view, t } = useOnce();
  return (
    <div aria-hidden className="mt-5 overflow-hidden rounded-lg border border-border-subtle text-[11px]">
      <div className="grid grid-cols-[1fr_auto] bg-muted px-3 py-1.5 font-medium text-faint">
        <span>Row · Offer letter</span>
        <span>Status</span>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-center bg-background/60 px-3 py-2 text-muted-foreground">
        <span className="truncate">B24-0387 · signed PDF + certificate</span>
        <motion.span className="badge badge-success" initial={{ opacity: 0, scale: 0.85 }} whileInView={{ opacity: 1, scale: 1 }} viewport={view} transition={t(0.4, 0.35)}>
          Signed
        </motion.span>
      </div>
    </div>
  );
}

/* ---------- Tiles ---------- */

const MAIL: Tile[] = [
  {
    icon: Rocket,
    title: 'Campaigns with a safety net',
    body: 'Preview every personalised email, run a dry run, and get approval before anything goes out.',
    span: 'md:col-span-2',
    art: <CampaignArt />,
  },
  { icon: Zap, title: 'Quick Send', body: 'Paste a list, upload a file, or pick a dataset or segment. Add RSVP buttons in one click.' },
  {
    icon: Users,
    title: 'Recruiter Bulk Send',
    body: 'Your own columns, individual copies or BCC, every mailbox together, and a preview per recruiter.',
    art: <TokenArt />,
  },
  {
    icon: Inbox,
    title: 'One shared inbox',
    body: 'Threads, assignment, tags, notes and SLAs, with AI triage that drafts replies you approve.',
    span: 'md:col-span-2',
    art: <InboxArt />,
  },
  { icon: Workflow, title: 'Automations', body: 'Conditions and follow-ups that run on their own, with signing presets built in.' },
  { icon: Sheet, title: 'Two-way Google Sheets sync', body: 'Your sheet stays the source of truth; changes flow both ways.' },
  { icon: FileText, title: 'Personalised PDFs', body: 'Attach a PDF filled in for each recipient, built in the PDF Library.' },
  {
    icon: BarChart3,
    title: 'Reports that arrive on time',
    body: 'Dashboard with first and average response times, an 8 PM daily report by email and Slack, and a weekly report.',
    span: 'md:col-span-3',
    art: <ReportArt />,
  },
];

const SIGN: Tile[] = [
  {
    icon: FileSignature,
    title: 'Bulk send for signature',
    body: 'Send one document to a whole batch, with up to 3 signers each, signing in order or in parallel.',
    span: 'md:col-span-2',
    art: <SignOrderArt />,
  },
  { icon: FileUp, title: 'Templates from Word or Google Docs', body: 'Import a .docx or a Doc link; {{fields}} are found for you and the formatting is kept.' },
  { icon: BellRing, title: 'Reminders and live status', body: 'Automatic reminders, and every signer’s status from Sent to Viewed to Signed.' },
  {
    icon: Braces,
    title: 'Signed PDF, certificate, write-back',
    body: 'Every signed copy comes with a certificate of completion, and the status is written back to the row.',
    span: 'md:col-span-2',
    art: <WriteBackArt />,
  },
];

const KICK: Record<string, string> = {
  'Campaigns with a safety net': 'The campaign',
  'Quick Send': 'Quick Send',
  'Recruiter Bulk Send': 'Recruiters',
  'One shared inbox': 'The inbox',
  Automations: 'Automations',
  'Two-way Google Sheets sync': 'Your sheet',
  'Personalised PDFs': 'Attachments',
  'Reports that arrive on time': 'Reports',
  'Bulk send for signature': 'Bulk sign',
  'Templates from Word or Google Docs': 'Templates',
  'Reminders and live status': 'Tracking',
  'Signed PDF, certificate, write-back': 'The paper trail',
};

function TileCard({ tile, index }: { tile: Tile; index: number }) {
  const Icon = tile.icon;
  return (
    <div data-r="" style={{ ['--d' as string]: `${Math.min(index * 35, 175)}ms` }} className={`card card-hover flex h-full flex-col ${tile.span ?? ''}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="card-kick">{KICK[tile.title] ?? tile.title}</span>
        <Icon size={18} aria-hidden className="text-[var(--on-deep-mu)]" />
      </div>
      <h3>{tile.title}</h3>
      <p>{tile.body}</p>
      {tile.art}
    </div>
  );
}

/**
 * Mail | Sign switcher (Leap's tab pills: dark tabs, the active one in accent) and the
 * feature bento under it. The nav's "Mail" and "Sign" links land here (#mail / #sign) and
 * pick the matching tab.
 */
export function Features() {
  const [product, setProduct] = useState<Product>('mail');
  const tiles = product === 'mail' ? MAIL : SIGN;

  useEffect(() => {
    const sync = () => {
      if (location.hash === '#sign') setProduct('sign');
      else if (location.hash === '#mail') setProduct('mail');
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const tab = (p: Product, label: string) => {
    const on = product === p;
    return (
      <button
        key={p}
        id={`tab-${p}`}
        type="button"
        role="tab"
        aria-selected={on}
        aria-controls="feature-panel"
        tabIndex={on ? 0 : -1}
        onClick={() => setProduct(p)}
        onKeyDown={(e) => {
          if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            const next: Product = e.key === 'Home' ? 'mail' : e.key === 'End' ? 'sign' : p === 'mail' ? 'sign' : 'mail';
            setProduct(next);
            document.getElementById(`tab-${next}`)?.focus();
          }
        }}
        className="tab"
      >
        {label}
      </button>
    );
  };

  return (
    <div>
      <div role="tablist" aria-label="Product" className="tabs">
        {tab('mail', 'MailFlow Mail')}
        {tab('sign', 'MailFlow Sign')}
      </div>
      <div id="feature-panel" role="tabpanel" aria-labelledby={`tab-${product}`} className="mt-8">
        <div key={product} className="grid gap-4 md:grid-cols-3">
          {tiles.map((tile, i) => (
            <TileCard key={tile.title} tile={tile} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
