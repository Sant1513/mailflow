'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion';
import { CheckCircle2, Inbox, Mail, PenLine, Send } from 'lucide-react';

/**
 * The hero's product mock, drawn in code (made-up data only): a campaign sending, replies
 * arriving in the shared inbox, and a signature request going from Viewed to Signed.
 *
 * One clock drives everything (a tick every 400 ms, 36 ticks a loop). It only runs while the
 * mock is on screen and the tab is visible; with "reduce motion" it never runs and the final
 * state is shown. Server HTML shows that same final state, so the first paint is complete.
 * Everything that moves is transform/opacity in fixed-size boxes, so nothing shifts.
 */
const TICK_MS = 400;
const LOOP = 36;
const REST = 30; // the state shown before the loop starts, and with reduced motion
const TOTAL = 480;
const ROW = 52; // inbox row height in px (rows are placed with transforms)

const REPLIES = [
  { at: 1, who: 'Student · B24-0142', text: 'Interested! Sharing my resume now.', tag: 'Reply', tone: 'badge-success' },
  { at: 11, who: 'Hiring partner', text: 'Away until Monday, will respond then.', tag: 'Out of office', tone: 'badge-neutral' },
  { at: 18, who: 'Student · B24-0387', text: 'Can I pick the 4 PM interview slot?', tag: 'Reply', tone: 'badge-success' },
  { at: 25, who: 'mailer-daemon', text: 'Address not found. Suppressed org-wide.', tag: 'Bounce', tone: 'badge-danger' },
] as const;

function signStatus(tick: number) {
  if (tick >= 22) return 'Signed';
  if (tick >= 9) return 'Viewed';
  return 'Sent';
}

export function HeroMock() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const onScreen = useInView(ref, { amount: 0.2 });
  const [tick, setTick] = useState(REST);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const running = !reduce && onScreen && !hidden;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % LOOP), TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);

  const t = reduce ? REST : tick;
  const sent = Math.min(TOTAL, Math.round((t / 28) * TOTAL));
  const progress = sent / TOTAL;
  const visible = REPLIES.filter((r) => r.at <= t).reverse().slice(0, 3);
  const status = signStatus(t);
  const done = sent === TOTAL;

  return (
    <div ref={ref} className="relative w-full" aria-label="Illustration of MailFlow with example data" role="img">
      <div aria-hidden>
        {/* Window chrome */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-primary/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-warning/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
          <span className="ml-2 truncate text-[11px] text-faint">MailFlow · Mail</span>
        </div>

        <div className="grid gap-3 p-3 sm:grid-cols-2 sm:p-5 lg:grid-cols-[1.15fr_1.25fr_0.9fr]">
          {/* Campaign card */}
          <div className="rounded-xl sm:col-span-2 lg:col-span-1 border border-border-subtle bg-background/60 p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[11px] text-faint">
                  <Mail size={12} /> Campaign
                </div>
                <div className="mt-0.5 truncate font-heading text-sm font-semibold text-foreground">Placement drive · Batch 24</div>
              </div>
              <span className="relative inline-flex h-[20px] w-[64px] shrink-0 justify-end">
                <AnimatePresence initial={false}>
                  <motion.span
                    key={done ? 'done' : 'sending'}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    className={`badge absolute right-0 top-0 ${done ? 'badge-success' : 'badge-danger'}`}
                  >
                    {done ? 'Sent' : 'Sending'}
                  </motion.span>
                </AnimatePresence>
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <motion.div
                className="h-full w-full origin-left rounded-full bg-gradient-to-r from-accent-from to-accent-to"
                initial={false}
                animate={{ scaleX: progress }}
                transition={{ duration: t === 0 ? 0.2 : TICK_MS / 1000, ease: 'linear' }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="tabular-nums">
                <span className="inline-block min-w-[3ch] text-right font-semibold text-foreground">{sent}</span> / {TOTAL} sent
              </span>
              <span className="hidden sm:inline">1 every 3 s · from your Gmail</span>
              <span className="sm:hidden">from your Gmail</span>
            </div>
          </div>

            {/* Inbox */}
            <div className="rounded-xl border border-border-subtle bg-background/60 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                  <Inbox size={12} /> Inbox
                </span>
                <span className="text-[10px] text-faint">threaded to the record</span>
              </div>
              <div className="relative overflow-hidden" style={{ height: ROW * 3 }}>
                <AnimatePresence initial={false}>
                  {visible.map((r, i) => (
                    <motion.div
                      key={r.at}
                      className="absolute inset-x-0 top-0"
                      style={{ height: ROW - 6 }}
                      initial={{ opacity: 0, y: -18 }}
                      animate={{ opacity: 1, y: i * ROW }}
                      exit={{ opacity: 0, y: 3 * ROW }}
                      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <div className="h-full rounded-lg border border-border-subtle bg-card px-2.5 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[11px] font-medium text-foreground">{r.who}</span>
                          <span className={`badge shrink-0 !text-[9.5px] ${r.tone}`}>{r.tag}</span>
                        </div>
                        <div className="truncate text-[10.5px] text-muted-foreground">{r.text}</div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>

            {/* Signature request */}
            <div className="flex flex-col rounded-xl border border-border-subtle bg-background/60 p-3">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                <PenLine size={12} /> Sign
              </span>
              <div className="mt-2 truncate text-xs font-semibold text-foreground">Offer letter</div>
              <div className="truncate text-[10.5px] text-muted-foreground">Candidate B24-0387</div>
              <ol className="mt-2.5 grid gap-1.5 text-[10.5px]">
                {['Candidate', 'Hiring manager'].map((who, i) => {
                  const signed = i === 0 ? status === 'Signed' : false;
                  return (
                    <li key={who} className="flex items-center gap-1.5 text-muted-foreground">
                      <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold ${signed ? 'bg-success/15 text-success' : 'bg-muted text-faint'}`}>{i + 1}</span>
                      <span className="truncate">{who}</span>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-auto pt-3">
                <span className="relative block h-[22px]">
                  <AnimatePresence initial={false}>
                    <motion.span
                      key={status}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className={`badge absolute left-0 top-0 gap-1 !py-1 ${status === 'Signed' ? 'badge-success' : status === 'Viewed' ? 'badge-warning' : 'badge-neutral'}`}
                    >
                      {status === 'Signed' ? <CheckCircle2 size={11} /> : <Send size={11} />}
                      {status}
                    </motion.span>
                  </AnimatePresence>
                </span>
              </div>
            </div>
        </div>
      </div>
    </div>
  );
}
