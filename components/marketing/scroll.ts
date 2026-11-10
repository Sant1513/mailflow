/**
 * Smooth anchor scrolling for the landing page (globals.css is shared with the app, so this is
 * done per click rather than with `scroll-behavior: smooth` on <html>). Instant with
 * "reduce motion". The hash is kept in the address bar so links can be shared.
 */
export function scrollToSection(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  e.preventDefault();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  history.replaceState(null, '', `#${id}`);
  // Move keyboard focus with the scroll, without a second jump.
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/** Hover lift for cards, only on devices that really hover, and never with reduced motion. */
export const LIFT =
  'transition-[transform,box-shadow] duration-300 [@media(hover:hover)]:hover:-translate-y-1 [@media(hover:hover)]:hover:shadow-lift motion-reduce:!translate-y-0';
