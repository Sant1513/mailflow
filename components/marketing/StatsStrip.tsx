'use client';

import { useEffect, useRef, useState } from 'react';
import { formatCounting } from '@/lib/marketing/format';
import type { PublicStat } from '@/lib/marketing/stats';

/**
 * A live total that counts up once, the first time it is on screen, then "lands" (a short
 * scale + coral glow). Server HTML and reduced motion show the real final value directly.
 * Space for the final text is reserved, so counting never moves anything around it.
 */
export function LiveCount({ stat, className = '' }: { stat: Pick<PublicStat, 'value' | 'display'>; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [text, setText] = useState(stat.display);
  const [landed, setLanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || stat.value < 10 || !('IntersectionObserver' in window)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const dur = 1100;
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          if (p < 1) {
            setText(formatCounting(eased * stat.value, stat.value));
            raf = requestAnimationFrame(tick);
          } else {
            setText(stat.display);
            setLanded(true);
          }
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [stat.value, stat.display]);

  return (
    <b ref={ref} style={{ minWidth: `${stat.display.length}ch` }} className={`${landed ? 'is-landed' : ''} ${className}`}>
      {text}
    </b>
  );
}

/** Row of live totals under the hero, separated by thin vertical rules. */
export function HeroStats({ stats }: { stats: PublicStat[] }) {
  if (!stats.length) return null;
  return (
    <div data-r="" style={{ ['--d' as string]: '140ms' }}>
      <dl className="hero-stats">
        {stats.map((s) => (
          <div key={s.key} className="hero-stat flex flex-col-reverse">
            <dt>
              <span>{s.label}</span>
            </dt>
            <dd>
              <LiveCount stat={s} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="foot-note mt-4 text-center">Live totals · rounded down · refreshed daily</p>
    </div>
  );
}
