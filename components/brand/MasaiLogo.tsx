/* eslint-disable @next/next/no-img-element -- small static brand files, served as-is */

/**
 * The Masai wordmark (the official logo, supplied by Masai) in the right colours for the theme:
 * dark letters on light backgrounds, white letters in dark mode; the red stays red.
 * `fixed="light"` for pages that are always light (public signing pages).
 */
export function MasaiLogo({ height = 24, className = '', fixed }: { height?: number; className?: string; fixed?: 'light' | 'dark' }) {
  const width = Math.round((height * 260) / 69);
  if (fixed) {
    return <img src={fixed === 'dark' ? '/brand/masai-logo-dark.png' : '/brand/masai-logo.png'} alt="Masai" width={width} height={height} className={className} style={{ height, width: 'auto' }} />;
  }
  return (
    <span className={`inline-flex ${className}`} aria-label="Masai">
      <img src="/brand/masai-logo.png" alt="Masai" width={width} height={height} className="dark:hidden" style={{ height, width: 'auto' }} />
      <img src="/brand/masai-logo-dark.png" alt="" aria-hidden width={width} height={height} className="hidden dark:block" style={{ height, width: 'auto' }} />
    </span>
  );
}

/** The round Masai "m" (the browser-tab icon), for tight spaces like the collapsed sidebar. */
export function MasaiMark({ size = 36, className = '' }: { size?: number; className?: string }) {
  return <img src="/icons/icon.svg" alt="Masai" width={size} height={size} className={`shrink-0 rounded-full ${className}`} style={{ width: size, height: size }} />;
}
