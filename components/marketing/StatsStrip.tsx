'use client';

import { useEffect, useRef, useState } from 'react';
import { animate, useInView, useReducedMotion } from 'framer-motion';
import { formatCounting } from '@/lib/marketing/format';
import type { PublicStat } from '@/lib/marketing/stats';

/** Counts up once to the rounded total, the first time it is seen. Final text from the server. */
function Counter({ stat }: { stat: Pick<PublicStat, 'value' | 'display'> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduce = useReducedMotion();
  // Server HTML (and reduced motion) shows the real final value; the count-up starts from 0
  // only once the strip is on screen in a browser that allows motion.
  const [text, setText] = useState(stat.display);

  useEffect(() => {
    if (!inView || reduce || stat.value < 10) return;
    const controls = animate(0, stat.value, {
      duration: 1.1,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setText(formatCounting(v, stat.value)),
      onComplete: () => setText(stat.display),
    });
    return () => controls.stop();
  }, [inView, reduce, stat.value, stat.display]);

  return (
    <span
      ref={ref}
      // Space for the final text is reserved, so counting never moves the label.
      style={{ minWidth: `${stat.display.length}ch` }}
      className="inline-block font-heading text-2xl font-bold tabular-nums tracking-tight text-foreground sm:text-[26px]"
    >
      {text}
    </span>
  );
}

export function StatsStrip({ stats }: { stats: PublicStat[] }) {
  if (!stats.length) return null;
  return (
    <div className="mt-8">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4 sm:gap-x-5">
        {stats.map((s) => (
          <div key={s.key} className="flex flex-col-reverse border-l-2 border-primary/70 pl-3">
            <dt className="text-xs text-muted-foreground">{s.label}</dt>
            <dd>
              <Counter stat={s} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[11px] text-faint">Live totals from MailFlow, rounded down and refreshed daily.</p>
    </div>
  );
}
