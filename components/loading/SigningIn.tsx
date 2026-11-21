'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoadingScreen } from '@/components/loading/LoadingScreen';

/**
 * The wait between pressing "Sign in" and landing in the app (MailFlow talks to Google first): a full-screen loading screen.
 * Drawn into the page body so a header with a blur or transform can't trap it.
 */
export function SigningIn({ text = 'Taking you to Google…' }: { text?: string }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  if (!host) return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-background">
      <LoadingScreen fullScreen label="Signing you in" context={[text]} page="general" />
    </div>,
    host,
  );
}
