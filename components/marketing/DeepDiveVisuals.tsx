'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { ArrowDown, Bot, Check, CheckCircle2, Clock, FileSpreadsheet, Link2, Sheet, ShieldCheck, ToggleRight } from 'lucide-react';
const EASE_OUT = [0.22, 0.61, 0.36, 1] as const;

/** Mock visuals for the three deep-dives. Made-up data; each plays once when first seen. */

function useOnce() {
  const reduce = useReducedMotion();
  return {
    view: { once: true, amount: 0.4 } as const,
    t: (delay = 0, duration = 0.6) => (reduce ? { duration: 0 } : { duration, delay, ease: EASE_OUT }),
  };
}

const LIMIT = 1500;

export function SendingVisual() {
  const { view, t } = useOnce();
  const boxes = [
    { name: 'Your mailbox', used: 1500, state: 'Limit reached · pauses', tone: 'badge-warning' },
    { name: 'Backup 1 (teammate)', used: 640, state: 'Taking over', tone: 'badge-danger' },
    { name: 'Backup 2 (teammate)', used: 120, state: 'Standing by', tone: 'badge-neutral' },
  ];
  return (
    <div aria-hidden className="panel p-5 sm:p-6">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">Mailbox usage · last 24 h</span>
        <span className="text-faint">stops at 1,500</span>
      </div>
      <ul className="mt-4 grid gap-4">
        {boxes.map((b, i) => (
          <li key={b.name}>
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className="truncate text-foreground">{b.name}</span>
              <span className={`badge shrink-0 ${b.tone}`}>{b.state}</span>
            </div>
            <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
              <motion.div
                className={`h-full w-full origin-left rounded-full ${i === 0 ? 'bg-warning' : 'bg-gradient-to-r from-accent-from to-accent-to'}`}
                initial={{ scaleX: 0 }}
                whileInView={{ scaleX: b.used / LIMIT }}
                viewport={view}
                transition={t(0.1 + i * 0.15, 0.9)}
              />
            </div>
            <div className="mt-1 text-[11px] tabular-nums text-faint">
              {b.used.toLocaleString('en-US')} / {LIMIT.toLocaleString('en-US')} · Google allows 2,000
            </div>
            {i === 0 && (
              <motion.div
                className="mt-2 flex items-center gap-1.5 text-[11px] text-primary"
                initial={{ opacity: 0, y: -4 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={view}
                transition={t(0.9, 0.4)}
              >
                <ArrowDown size={12} /> remaining emails move to the next backup
              </motion.div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-5 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
        <Clock size={12} /> One email every 3 seconds per mailbox, even with the tab closed.
      </div>
    </div>
  );
}

export function InboxVisual() {
  const { view, t } = useOnce();
  const thread = [
    { who: 'You · campaign email', text: 'Interview slots for Batch 24 are open…', tag: 'Sent', tone: 'badge-neutral', mine: true },
    { who: 'Student · B24-0142', text: 'Thanks! Is the 4 PM slot still free?', tag: 'Reply', tone: 'badge-success', mine: false },
  ];
  return (
    <div aria-hidden className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="badge badge-success">Reply</span>
        <span className="badge badge-neutral">Out of office</span>
        <span className="badge badge-danger">Bounce</span>
        <span className="ml-auto text-[11px] text-faint">all threaded to the record</span>
      </div>
      <ul className="mt-4 grid gap-2">
        {thread.map((m, i) => (
          <motion.li
            key={m.who}
            className={`rounded-xl border border-border-subtle px-3 py-2.5 ${m.mine ? 'bg-muted' : 'bg-background/60'}`}
            initial={{ opacity: 0, x: m.mine ? -12 : 12 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={view}
            transition={t(0.1 + i * 0.2, 0.4)}
          >
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate font-medium text-foreground">{m.who}</span>
              <span className={`badge shrink-0 ${m.tone}`}>{m.tag}</span>
            </div>
            <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{m.text}</p>
          </motion.li>
        ))}
      </ul>
      <motion.div
        className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3"
        initial={{ opacity: 0, y: 10 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={view}
        transition={t(0.6, 0.45)}
      >
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
          <Bot size={13} /> AI draft · waiting for you
        </div>
        <p className="mt-1 text-[12px] text-muted-foreground">Yes, 4 PM is free. I have booked it for you; the joining link follows.</p>
        <div className="mt-2.5 flex gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1 text-[11px] font-semibold text-ink-foreground">
            <Check size={12} /> Approve &amp; send
          </span>
          <span className="inline-flex items-center rounded-full border border-border px-3 py-1 text-[11px] text-foreground">Edit</span>
        </div>
      </motion.div>
    </div>
  );
}

export function SigningVisual() {
  const { view, t } = useOnce();
  const signers = [
    { who: 'Student', status: 'Signed' },
    { who: 'Guardian', status: 'Signed' },
    { who: 'Masai', status: 'Signed' },
  ];
  return (
    <div aria-hidden className="panel p-5 sm:p-6">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">Agreement · in order 1 → 2 → 3</span>
        <span className="text-faint">batch of 120</span>
      </div>
      <ol className="mt-4 grid gap-2">
        {signers.map((s, i) => (
          <li key={s.who} className="flex items-center gap-3 rounded-xl border border-border-subtle bg-background/60 px-3 py-2.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground">{i + 1}</span>
            <span className="flex-1 truncate text-[12px] text-foreground">{s.who}</span>
            <span className="relative h-[20px] w-[64px]">
              <motion.span
                className="badge badge-warning absolute right-0 top-0"
                initial={{ opacity: 1 }}
                whileInView={{ opacity: 0 }}
                viewport={view}
                transition={t(0.3 + i * 0.45, 0.2)}
              >
                Waiting
              </motion.span>
              <motion.span
                className="badge badge-success absolute right-0 top-0 gap-1"
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={view}
                transition={t(0.3 + i * 0.45, 0.3)}
              >
                <CheckCircle2 size={11} /> {s.status}
              </motion.span>
            </span>
          </li>
        ))}
      </ol>
      <motion.div
        className="mt-4 overflow-hidden rounded-xl border border-border-subtle"
        initial={{ opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={view}
        transition={t(1.7, 0.4)}
      >
        <div className="flex items-center gap-1.5 bg-muted px-3 py-1.5 text-[11px] font-medium text-faint">
          <Sheet size={12} /> Your data · written back
        </div>
        <div className="grid grid-cols-3 gap-2 bg-background/60 px-3 py-2 text-[11px] text-muted-foreground">
          <span className="truncate">B24-0142</span>
          <span className="truncate text-success">Signed</span>
          <span className="truncate">PDF + certificate</span>
        </div>
      </motion.div>
    </div>
  );
}

export function ConnectVisual() {
  const { view, t } = useOnce();
  return (
    <div aria-hidden className="panel p-5 sm:p-6">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">Settings · Gmail</span>
        <span className="text-faint">your own mailbox</span>
      </div>
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-border-subtle bg-background/60 px-3 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Link2 size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">you@yourteam</div>
          <div className="truncate text-[11px] text-faint">Google sign-in · token encrypted at rest</div>
        </div>
        <motion.span className="badge badge-success shrink-0" initial={{ opacity: 0, scale: 0.85 }} whileInView={{ opacity: 1, scale: 1 }} viewport={view} transition={t(0.3, 0.35)}>
          Connected
        </motion.span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-background/60 px-3 py-2.5 text-[12px] text-muted-foreground">
        <span className="truncate">Allow my mailbox as a backup sender</span>
        <ToggleRight size={20} className="shrink-0 text-primary" />
      </div>
    </div>
  );
}

export function DataVisual() {
  const { view, t } = useOnce();
  const cols = ['Name', 'Email', 'Batch', 'Slot'];
  const rows = [
    ['Student A', 'a@example.com', 'B24', '4 PM'],
    ['Student B', 'b@example.com', 'B24', '5 PM'],
    ['Student C', 'c@example.com', 'B25', '4 PM'],
  ];
  return (
    <div aria-hidden className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="badge badge-neutral gap-1"><FileSpreadsheet size={11} /> CSV / Excel</span>
        <span className="badge badge-neutral gap-1"><Sheet size={11} /> Google Sheet · two-way</span>
        <span className="badge badge-neutral">Segment</span>
      </div>
      <div className="mt-4 overflow-hidden rounded-xl border border-border-subtle text-[11px]">
        <div className="grid grid-cols-4 gap-2 bg-muted px-3 py-1.5 font-medium text-faint">
          {cols.map((c) => (
            <span key={c} className="truncate">{c}</span>
          ))}
        </div>
        {rows.map((r, i) => (
          <motion.div
            key={r[0]}
            className="grid grid-cols-4 gap-2 border-t border-border-subtle bg-background/60 px-3 py-2 text-muted-foreground"
            initial={{ opacity: 0, y: 6 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={view}
            transition={t(0.1 + i * 0.1, 0.35)}
          >
            {r.map((v) => (
              <span key={v} className="truncate">{v}</span>
            ))}
          </motion.div>
        ))}
      </div>
      <div className="mt-3 rounded-lg bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">
        Hi <span className="text-primary">{'{{Name}}'}</span>, your interview is at <span className="text-primary">{'{{Slot}}'}</span>.
      </div>
    </div>
  );
}

export function ApproveVisual() {
  const { view, t } = useOnce();
  const skipped = [
    ['Unsubscribed', 3],
    ['Bounced before', 2],
    ['No-reply address', 1],
  ] as const;
  return (
    <div aria-hidden className="panel p-5 sm:p-6">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">Dry run · Placement drive</span>
        <span className="text-faint">nothing sent yet</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border-subtle bg-background/60 p-3">
          <div className="text-[22px] font-bold tabular-nums text-foreground">412</div>
          <div className="text-[11px] text-faint">will receive</div>
        </div>
        <div className="rounded-xl border border-border-subtle bg-background/60 p-3">
          <div className="text-[22px] font-bold tabular-nums text-foreground">6</div>
          <div className="text-[11px] text-faint">skipped, with the reason</div>
        </div>
      </div>
      <ul className="mt-3 grid gap-1.5">
        {skipped.map(([why, n], i) => (
          <motion.li
            key={why}
            className="flex items-center justify-between rounded-lg bg-muted px-3 py-1.5 text-[11px] text-muted-foreground"
            initial={{ opacity: 0, x: 10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={view}
            transition={t(0.1 + i * 0.1, 0.35)}
          >
            <span>{why}</span>
            <span className="tabular-nums">{n}</span>
          </motion.li>
        ))}
      </ul>
      <motion.div
        className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2.5"
        initial={{ opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={view}
        transition={t(0.5, 0.4)}
      >
        <span className="flex items-center gap-1.5 text-[11px] text-primary">
          <ShieldCheck size={13} /> Waiting for an admin
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1 text-[11px] font-semibold text-ink-foreground">
          <Check size={12} /> Approve &amp; send
        </span>
      </motion.div>
    </div>
  );
}
