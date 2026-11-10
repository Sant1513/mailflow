'use client';

import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { BrandLockup } from './BrandLockup';
import { GoogleCta } from './GoogleCta';

const LINKS = [
  { href: '#mail', label: 'Mail' },
  { href: '#sign', label: 'Sign' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#security', label: 'Security' },
  { href: '#faq', label: 'FAQ' },
];

/**
 * Fixed nav (blurred deep bar) with the announcement marquee under it. The marquee holds the
 * items twice (the copy is aria-hidden) and scrolls by half its width, so it loops seamlessly;
 * it pauses on hover and stands still with "reduce motion".
 */
export function Nav({ announcements }: { announcements: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  // Repeat the items so one group is always wider than the screen.
  const items = [...announcements, ...announcements];
  const group = (hidden: boolean) => (
    <div className="ns-group" aria-hidden={hidden || undefined}>
      {items.map((a, i) => (
        <span key={`${a}-${i}`} className="ns-item" aria-hidden={!hidden && i >= announcements.length ? true : undefined}>
          {a}
        </span>
      ))}
    </div>
  );

  return (
    <header ref={ref} className="nav">
      <div className="wrap">
        <nav aria-label="Main" className="nav-bar">
          <a href="#top" className="brand" aria-label="MailFlow by Masai, back to top">
            <BrandLockup />
          </a>
          <ul className="nav-links">
            {LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3">
            <GoogleCta small className="nav-cta" />
            <button
              type="button"
              className="burger"
              aria-expanded={open}
              aria-controls="lp-menu"
              aria-label={open ? 'Close menu' : 'Open menu'}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
            </button>
          </div>
        </nav>
        {open && (
          <div id="lp-menu" className="nav-menu">
            <ul>
              {LINKS.map((l) => (
                <li key={l.href}>
                  <a href={l.href} onClick={() => setOpen(false)}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
            <div className="mt-5">
              <GoogleCta className="w-full" />
            </div>
          </div>
        )}
      </div>
      {announcements.length > 0 && (
        <div className="nav-strip" role="region" aria-label="About MailFlow">
          <div className="ns-marquee">
            <div className="ns-track">
              {group(false)}
              {group(true)}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
