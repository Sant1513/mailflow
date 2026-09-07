'use client';

import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_KEY = 'mailflow.theme';

/**
 * Runs before first paint (inlined by app/layout.tsx) so the page never
 * flashes the wrong theme. Kept as a string because it must execute before
 * React hydrates.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k='${THEME_KEY}';var p=localStorage.getItem(k)||'system';var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var c=document.documentElement.classList;d?c.add('dark'):c.remove('dark');document.documentElement.setAttribute('data-theme',p);}catch(e){}})();`;

export function applyTheme(pref: ThemePreference) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.setAttribute('data-theme', pref);
}

export function readTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '◐' },
  { value: 'light', label: 'Light', icon: '☀' },
  { value: 'dark', label: 'Dark', icon: '☾' },
];

/** Three-state theme switch: System / Light / Dark, persisted per browser. */
export function ThemeToggle({ compact }: { compact?: boolean }) {
  const [pref, setPref] = useState<ThemePreference>('system');

  useEffect(() => {
    setPref(readTheme());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (readTheme() === 'system') applyTheme('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  function choose(next: ThemePreference) {
    setPref(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode */
    }
    applyTheme(next);
  }

  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-full border border-border bg-card p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={pref === o.value}
          onClick={() => choose(o.value)}
          title={o.label}
          className={`rounded-full px-2 py-1 text-xs transition ${pref === o.value ? 'bg-elevated text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <span aria-hidden>{o.icon}</span>
          {!compact && <span className="ml-1">{o.label}</span>}
        </button>
      ))}
    </div>
  );
}
