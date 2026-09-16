'use client';

import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'pwa-install-dismissed';

export function InstallPrompt() {
  const [prompt, setPrompt] = useState<any>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISSED_KEY)) return;
    } catch { /* no-op */ }

    // Already installed (running in standalone mode).
    if (window.matchMedia('(display-mode: standalone)').matches) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setPrompt(e);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  function dismiss() {
    setVisible(false);
    try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* no-op */ }
  }

  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') {
      setVisible(false);
    } else {
      dismiss();
    }
    setPrompt(null);
  }

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-lg">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary">
        <img src="/icons/icon.svg" alt="" className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">Add MailFlow to Home Screen</div>
        <div className="truncate text-xs text-muted-foreground">Works offline · No app store needed</div>
      </div>
      <button onClick={install} className="btn-primary shrink-0 !px-3 !py-1.5 text-xs">
        Install
      </button>
      <button onClick={dismiss} className="shrink-0 text-sm text-muted-foreground hover:text-foreground" title="Dismiss">
        ✕
      </button>
    </div>
  );
}
