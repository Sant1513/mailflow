'use client';

import { useEffect } from 'react';

export function SwRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => console.warn('[pwa] SW registration failed', err));
  }, []);

  return null;
}
