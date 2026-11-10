'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { ArrowDown, Bot, Check, CheckCircle2, Clock, Sheet } from 'lucide-react';
import { EASE_OUT } from './Reveal';

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
