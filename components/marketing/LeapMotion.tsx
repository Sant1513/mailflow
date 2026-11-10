'use client';

import { useEffect, useState } from 'react';
import { GoogleCta } from './GoogleCta';

/**
 * Runs before the page paints (inlined at the top of the landing page): marks <html> with
 * `lp-js` only when IntersectionObserver exists, because that class is what hides the
 * [data-r] elements until they scroll in. Without it (no JS, old browsers) everything shows.
 */
export const LEAP_JS_SCRIPT = `if("IntersectionObserver" in window)document.documentElement.classList.add("lp-js");`;

/**
 * Leap's reveal system: [data-r] elements (and .inv section backgrounds) get `.in` once, the
 * first time they come on screen (rootMargin 0 0 -6% 0, threshold .05). Elements that appear
 * later (lazy chunks, tab switches) are picked up by a MutationObserver.
 */
export function RevealObserver() {
  useEffect(() => {
    const root = document.querySelector('.leap-ui');
    if (!root || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.05 },
    );
    const seen = new WeakSet<Element>();
    const scan = () => {
      root.querySelectorAll('[data-r]:not(.in), .inv:not(.in)').forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        io.observe(el);
      });
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, []);
  return null;
}

/**
 * Slim "Sign in with Google" bar fixed to the bottom. It slides up only while none of the
 * page's own sign-in buttons ([data-cta]: hero and closing band) nor the top of the page are
 * on screen, and hides again as soon as one is.
 */
export function CtaBar() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    const targets = [...document.querySelectorAll('.leap-ui [data-cta]')].filter((el) => !el.closest('.cta-bar'));
    const top = document.getElementById('top');
    if (top) targets.push(top);
    if (!targets.length) return;
    const visible = new Set<Element>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
      setOn(visible.size === 0);
    });
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, []);

  return (
    // Hidden state is `visibility: hidden` (in leap.css), which also takes it out of the tab order.
    <div className={`cta-bar ${on ? 'is-on' : ''}`}>
      <div className="wrap flex items-center justify-between gap-4">
        <p className="hidden text-sm text-[var(--on-deep-2)] sm:block">
          <span className="font-semibold text-[var(--paper)]">MailFlow</span> · every email to every batch, sent from your Gmail.
        </p>
        <GoogleCta small className="w-full sm:w-auto" />
      </div>
    </div>
  );
}
