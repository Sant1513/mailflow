'use client';

import { useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { Menu, X } from 'lucide-react';
import { MasaiLogo } from '@/components/brand/MasaiLogo';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { scrollToSection } from './scroll';

const LINKS = [
  { id: 'features', label: 'Features' },
  { id: 'how-it-works', label: 'How it works' },
  { id: 'security', label: 'Security' },
  { id: 'faq', label: 'FAQ' },
];

function SignInButton({ className = '' }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        setBusy(true);
        signIn('google', { callbackUrl: '/' });
      }}
      disabled={busy}
      className={`btn-primary !px-4 !py-1.5 disabled:cursor-wait ${className}`}
    >
      {busy ? 'Connecting…' : 'Sign in'}
    </button>
  );
}

/** Sticky glass top bar: logo, section links, theme and sign-in; a compact menu on phones. */
export function TopBar() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-40 px-3 pt-3 sm:px-6">
      <div ref={menuRef} className="glass-nav mx-auto max-w-6xl rounded-2xl">
        <nav aria-label="Main" className="flex h-14 items-center justify-between gap-3 px-3 sm:px-4">
          <a href="#top" onClick={(e) => scrollToSection(e, 'top')} className="flex shrink-0 items-center gap-2.5 rounded-lg" aria-label="MailFlow home">
            <MasaiLogo height={22} />
            <span aria-hidden className="h-5 w-px bg-border" />
            <span className="font-heading text-[15px] font-semibold tracking-tight text-foreground">MailFlow</span>
          </a>

          <ul className="hidden items-center gap-1 md:flex">
            {LINKS.map((l) => (
              <li key={l.id}>
                <a
                  href={`#${l.id}`}
                  onClick={(e) => scrollToSection(e, l.id)}
                  className="rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:bg-elevated hover:text-foreground"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2">
            <div className="hidden sm:block">
              <ThemeToggle compact />
            </div>
            <SignInButton className="hidden sm:inline-flex" />
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-foreground md:hidden"
              aria-expanded={open}
              aria-controls="landing-menu"
              aria-label={open ? 'Close menu' : 'Open menu'}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
            </button>
          </div>
        </nav>

        {open && (
          <div id="landing-menu" className="border-t border-border-subtle px-3 pb-4 pt-2 md:hidden">
            <ul className="grid gap-1">
              {LINKS.map((l) => (
                <li key={l.id}>
                  <a
                    href={`#${l.id}`}
                    onClick={(e) => {
                      setOpen(false);
                      scrollToSection(e, l.id);
                    }}
                    className="block rounded-xl px-3 py-2.5 text-sm text-foreground hover:bg-elevated"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center justify-between gap-3 px-1">
              <ThemeToggle compact />
              <SignInButton />
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
