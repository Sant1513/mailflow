'use client';

import { useEffect, useRef, useState } from 'react';
import { frameDocument } from '@/lib/conversations/frameDoc';

/**
 * §50 message body: sanitised HTML in a frame that grows to its content.
 * `allow-same-origin` (and nothing else) lets the parent read the height;
 * scripts still cannot run because allow-scripts is absent, and the HTML
 * was sanitised server-side before it got here.
 *
 * When `collapsible` is true, messages taller than COLLAPSE_THRESHOLD are
 * clamped to PREVIEW_HEIGHT with a gradient overlay and a "Show full message"
 * toggle, matching the UX of Gmail's "message clipped" disclosure.
 */

const COLLAPSE_THRESHOLD = 280; // px — taller than this → start collapsed
const PREVIEW_HEIGHT = 200;      // px — height of the collapsed preview

export function MessageBody({
  main,
  quoted,
  compact,
  collapsible = false,
}: {
  main: string;
  quoted: string | null;
  compact?: boolean;
  collapsible?: boolean;
}) {
  const [showQuoted, setShowQuoted] = useState(false);
  const [collapsed, setCollapsed] = useState(false); // true = user chose to collapse
  const [expanded, setExpanded]   = useState(false); // true = user expanded a tall message
  const [fullHeight, setFullHeight] = useState<number | null>(null);
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(compact ? 80 : 120);

  const doc = frameDocument(showQuoted && quoted ? `${main}\n${quoted}` : main);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      try {
        const body = el.contentDocument?.body;
        const html = el.contentDocument?.documentElement;
        if (!body || !html) return;
        const h = Math.max(body.scrollHeight, html.scrollHeight);
        if (h > 0) {
          const capped = Math.min(h + 4, 4000);
          setFullHeight(capped);
          // Auto-collapse if collapsible and tall enough and user hasn't acted yet.
          if (collapsible && capped > COLLAPSE_THRESHOLD) {
            setCollapsed((prev) => {
              // Only set on first measure; don't override a user toggle.
              if (prev === false && !expanded) return true;
              return prev;
            });
            setHeight(capped);
          } else {
            setHeight(capped);
          }
        }
      } catch {
        /* cross-origin fallback */
      }
    };
    const onLoad = () => {
      measure();
      let n = 0;
      const tick = () => {
        measure();
        if (++n < 6) raf = window.setTimeout(tick, 250);
      };
      tick();
    };
    el.addEventListener('load', onLoad);
    return () => {
      el.removeEventListener('load', onLoad);
      window.clearTimeout(raf);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, collapsible]);

  const isTall = collapsible && fullHeight != null && fullHeight > COLLAPSE_THRESHOLD;
  const displayHeight = isTall && collapsed && !expanded ? PREVIEW_HEIGHT : height;

  return (
    <div>
      {/* Frame wrapper — clips to displayHeight when collapsed */}
      <div
        className="relative overflow-hidden transition-all duration-200"
        style={{ height: displayHeight }}
      >
        <iframe
          ref={ref}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={doc}
          title="Message"
          scrolling="no"
          style={{
            width: '100%',
            height,
            border: 0,
            borderRadius: 6,
            background: '#fff',
            display: 'block',
          }}
        />
        {/* Gradient fade when clipped */}
        {isTall && collapsed && !expanded && (
          <div
            className="pointer-events-none absolute bottom-0 left-0 right-0 h-16"
            style={{ background: 'linear-gradient(to bottom, transparent, var(--card, #fff))' }}
          />
        )}
      </div>

      {/* Toggle row */}
      <div className="mt-1 flex flex-wrap items-center gap-3">
        {/* Collapse / expand for tall messages */}
        {isTall && (
          <button
            onClick={() => {
              if (collapsed) {
                setCollapsed(false);
                setExpanded(true);
              } else {
                setCollapsed(true);
                setExpanded(false);
              }
            }}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {collapsed && !expanded ? '↕ Show full message' : '↑ Collapse'}
          </button>
        )}

        {/* Quoted-history toggle */}
        {quoted && (
          <button
            onClick={() => setShowQuoted((v) => !v)}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {showQuoted ? 'Hide quoted text' : '··· Show quoted text'}
          </button>
        )}
      </div>
    </div>
  );
}
