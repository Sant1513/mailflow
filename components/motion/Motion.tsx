'use client';

import { animate, motion, MotionConfig, useInView, useReducedMotion, type Variants } from 'framer-motion';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * The app's motion vocabulary (one place, so every page moves the same way):
 *  - PageTransition: a page fades and rises in from a soft blur when you open it.
 *  - Stagger / StaggerItem: cards arrive one after another, left to right.
 *  - Lift: cards rise a little under the pointer.
 *  - CountUp: numbers count up to their value.
 * Everything respects the system "reduce motion" setting.
 */

export const EASE = [0.22, 1, 0.36, 1] as const;

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user" transition={{ ease: EASE }}>{children}</MotionConfig>;
}

/**
 * Keyed by the path so each page plays its entrance. The blur and offset are removed once it
 * ends (transitionEnd), because a lingering filter/transform would break `position: fixed`
 * dialogs inside the page.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <motion.div
      key={pathname}
      initial={{ opacity: 0, y: 14, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none', transform: 'none' } }}
      transition={{ duration: 0.5, ease: EASE }}
      className="h-full"
    >
      {children}
    </motion.div>
  );
}

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.08 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 16, filter: 'blur(6px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.5, ease: EASE }, transitionEnd: { filter: 'none' } },
};

/** A group whose StaggerItems appear one after another. */
export function Stagger({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={container} initial="hidden" animate="show">
      {children}
    </motion.div>
  );
}

/** One card in a Stagger; `lift` makes it rise under the pointer. */
export function StaggerItem({ children, className, lift = true }: { children: React.ReactNode; className?: string; lift?: boolean }) {
  return (
    <motion.div className={className} variants={item} whileHover={lift ? { y: -4, transition: { duration: 0.2 } } : undefined}>
      {children}
    </motion.div>
  );
}

/** Fades and rises in when scrolled into view (for sections lower on the page). */
export function Reveal({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 18 }}
      animate={inView ? { opacity: 1, y: 0, transitionEnd: { transform: 'none' } } : undefined}
      transition={{ duration: 0.55, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Counts up to the number inside `value` ("1,234", "42%", "₹3.2K"), keeping the text around it.
 * Values without a number ("—", "3h 20m") are shown as they are.
 */
export function CountUp({ value, duration = 1.1 }: { value: string; duration?: number }) {
  const reduce = useReducedMotion();
  const match = /^([^\d-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/.exec(value);
  const target = match ? Number(match[2]!.replace(/,/g, '')) : NaN;
  const decimals = match?.[2]?.includes('.') ? match[2].split('.')[1]!.length : 0;
  const grouped = !!match?.[2]?.includes(',');
  const [shown, setShown] = useState(reduce || !Number.isFinite(target) ? value : `${match?.[1] ?? ''}0${match?.[3] ?? ''}`);

  useEffect(() => {
    if (reduce || !match || !Number.isFinite(target)) {
      setShown(value);
      return;
    }
    const format = (n: number) => {
      const fixed = n.toFixed(decimals);
      const text = grouped ? Number(fixed).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : fixed;
      return `${match[1]}${text}${match[3]}`;
    };
    const controls = animate(0, target, { duration, ease: EASE, onUpdate: (n) => setShown(format(n)) });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduce]);

  return <span className="tabular-nums">{shown}</span>;
}

/** Shimmering placeholder block for loading states. */
export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden />;
}
