'use client';

import { scrollToSection } from './scroll';

/** An in-page link that scrolls smoothly (instantly with reduced motion) to a section id. */
export function SectionLink({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) {
  return (
    <a href={`#${to}`} onClick={(e) => scrollToSection(e, to)} className={className}>
      {children}
    </a>
  );
}
