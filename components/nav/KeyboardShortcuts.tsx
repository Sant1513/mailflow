'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { lastPathFor, markCurrentProduct } from '@/lib/products-client';

const SHORTCUTS = [
  { keys: '?', description: 'Show this help' },
  { keys: 'g i', description: 'Go to Inbox' },
  { keys: 'g c', description: 'Go to Campaigns' },
  { keys: 'g d', description: 'Go to Dashboard' },
  { keys: 'g s', description: 'Go to Settings' },
  { keys: 'g m', description: 'Switch to Mail' },
  { keys: 'g e', description: 'Switch to Sign (e-signature)' },
];

/** Keyboard shortcuts for the app shell. Chords like "g i" have a 1.5 s window. */
export function KeyboardShortcuts() {
  const router = useRouter();
  const [showHelp, setShowHelp] = useState(false);
  const pendingG = useRef(false);
  const chordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function isEditable(el: EventTarget | null): boolean {
      if (!(el instanceof Element)) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    }

    function clearChord() {
      pendingG.current = false;
      if (chordTimer.current) {
        clearTimeout(chordTimer.current);
        chordTimer.current = null;
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isEditable(e.target)) return;
      // Ignore modified keys (Ctrl/Alt/Meta combos) except plain Shift (for "?").
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // If we are waiting for the second chord key after "g":
      if (pendingG.current) {
        clearChord();
        switch (e.key.toLowerCase()) {
          case 'i': router.push('/inbox'); return;
          case 'c': router.push('/campaigns'); return;
          case 'd': router.push('/dashboard'); return;
          case 's': router.push('/settings'); return;
          case 'm': markCurrentProduct('mail'); router.push(lastPathFor('mail')); return;
          case 'e': markCurrentProduct('sign'); router.push(lastPathFor('sign')); return;
        }
        // Unknown second key — fall through to normal handling.
      }

      switch (e.key) {
        case '?':
          setShowHelp((v) => !v);
          break;
        case 'Escape':
          setShowHelp(false);
          break;
        case 'g':
          pendingG.current = true;
          chordTimer.current = setTimeout(clearChord, 1500);
          break;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      clearChord();
    };
  }, [router]);

  // Close help modal on outside click.
  useEffect(() => {
    if (!showHelp) return;
    function onMouseDown(e: MouseEvent) {
      if (overlayRef.current && e.target === overlayRef.current) {
        setShowHelp(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showHelp]);

  if (!showHelp) return null;

  return (
    /* Fixed backdrop — clicking the backdrop (not the card) closes the modal. */
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm"
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">Keyboard Shortcuts</h2>
          <button
            onClick={() => setShowHelp(false)}
            aria-label="Close shortcuts"
            className="rounded-md p-1 text-muted-foreground hover:bg-elevated hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle">
              <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Keys</th>
              <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map(({ keys, description }) => (
              <tr key={keys} className="border-b border-border-subtle last:border-0">
                <td className="py-2 pr-4">
                  <span className="inline-flex gap-1">
                    {keys.split(' ').map((k) => (
                      <kbd
                        key={k}
                        className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </td>
                <td className="py-2 text-muted-foreground">{description}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="mt-4 text-center text-[11px] text-faint">
          Press <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">Esc</kbd> or click outside to close
        </p>
      </div>
    </div>
  );
}
