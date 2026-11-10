'use client';

import { motion, useReducedMotion } from 'framer-motion';

/**
 * Landing-page reveal: content rises in once, the first time a quarter of it is on screen
 * (420 ms, ease-out). Items in a row pass `index` and arrive 60 ms apart. Each item watches
 * itself, so a tall grid on a phone never waits for a share of it that can't fit on screen.
 * Transform and opacity only, so nothing shifts. With "reduce motion" the same markup is
 * rendered and shown at once (duration 0), keeping server and client HTML identical.
 */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

type Tag = 'div' | 'li' | 'section' | 'article';

export function Reveal({
  children,
  className,
  as = 'div',
  index = 0,
  id,
}: {
  children: React.ReactNode;
  className?: string;
  as?: Tag;
  /** Position in a row: delays this item by 60 ms per step (capped so late items don't lag). */
  index?: number;
  id?: string;
}) {
  const reduce = useReducedMotion();
  const Component = motion[as];
  return (
    <Component
      id={id}
      className={className}
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={reduce ? { duration: 0 } : { duration: 0.42, ease: EASE_OUT, delay: Math.min(index, 6) * 0.06 }}
    >
      {children}
    </Component>
  );
}
