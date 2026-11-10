'use client';

import { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useSpring } from 'framer-motion';
import { Database, Link2, MessagesSquare, ShieldCheck, type LucideIcon } from 'lucide-react';
import { Reveal } from './Reveal';

const STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Link2, title: 'Connect Gmail', body: 'Sign in with Google and connect the mailbox you already send from. No new address, no "noreply".' },
  { icon: Database, title: 'Bring your data', body: 'Upload a CSV or Excel file, paste a list, or link a Google Sheet. Every column becomes a {{field}}.' },
  { icon: ShieldCheck, title: 'Dry run & approve', body: 'See exactly who gets what and who is skipped, and why. Sends from non-admins wait for approval.' },
  { icon: MessagesSquare, title: 'Send & track replies', body: 'Emails go out at a safe pace; replies, bounces and out-of-office land in one shared inbox.' },
];

/**
 * Four steps joined by a line that draws as the section scrolls through the viewport
 * (scroll-linked scale, never scroll-jacking). Fully drawn with "reduce motion".
 */
export function HowItWorks() {
  const ref = useRef<HTMLOListElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 85%', 'end 55%'] });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30, restDelta: 0.001 });
  const scale = reduce ? 1 : progress;

  return (
    <ol ref={ref} className="relative grid gap-8 md:grid-cols-4 md:gap-6">
      {/* Track + drawn line: vertical on phones, horizontal from md up */}
      <span aria-hidden className="absolute bottom-6 left-[19px] top-6 w-px bg-border md:hidden" />
      <motion.span aria-hidden style={{ scaleY: scale }} className="absolute bottom-6 left-[19px] top-6 w-px origin-top bg-primary md:hidden" />
      <span aria-hidden className="absolute left-[12.5%] right-[12.5%] top-5 hidden h-px bg-border md:block" />
      <motion.span aria-hidden style={{ scaleX: scale }} className="absolute left-[12.5%] right-[12.5%] top-5 hidden h-px origin-left bg-primary md:block" />

      {STEPS.map((s, i) => {
        const Icon = s.icon;
        return (
          <Reveal as="li" key={s.title} index={i} className="relative flex gap-4 md:flex-col md:items-center md:text-center">
            <span className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-card text-primary shadow-card">
              <Icon size={18} aria-hidden />
            </span>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Step {i + 1}</div>
              <h3 className="mt-1 font-heading text-base font-semibold text-foreground">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground md:mx-auto md:max-w-[15rem]">{s.body}</p>
            </div>
          </Reveal>
        );
      })}
    </ol>
  );
}
