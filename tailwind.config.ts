import type { Config } from 'tailwindcss';

/**
 * Tailwind is mapped onto the CSS variables in app/globals.css, so the
 * palette lives in exactly one place. Every colour here is a token; no
 * component should reach for a raw Tailwind hue on a UI surface.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: 'hsl(var(--card))',
        elevated: 'hsl(var(--elevated))',
        muted: 'hsl(var(--muted))',
        'muted-foreground': 'hsl(var(--muted-foreground))',
        faint: 'hsl(var(--faint))',
        border: 'hsl(var(--border))',
        'border-subtle': 'hsl(var(--border-subtle))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          hover: 'hsl(var(--primary-hover))',
        },
        'primary-foreground': 'hsl(var(--primary-foreground))',
        destructive: 'hsl(var(--destructive))',
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        info: 'hsl(var(--info))',
        ring: 'hsl(var(--ring))',
      },
      fontFamily: {
        // Outfit for everything, Poppins as the reference site's secondary.
        sans: ['var(--font-outfit)', 'var(--font-poppins)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        heading: ['var(--font-outfit)', 'var(--font-poppins)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        // Cards are 8px on the reference; controls are tighter; CTAs are pills.
        lg: 'var(--radius-card)',
        md: '6px',
        sm: '4px',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--ease)',
      },
      transitionDuration: {
        DEFAULT: '180ms',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.3s var(--ease) both',
        'rise-in': 'rise-in 0.35s var(--ease) both',
      },
    },
  },
  plugins: [],
};

export default config;
