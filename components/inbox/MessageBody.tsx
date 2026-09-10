'use client';

import { useEffect, useRef, useState } from 'react';
import { frameDocument } from '@/lib/conversations/frameDoc';

/**
 * §50 message body: sanitised HTML in a frame that grows to its content.
 * `allow-same-origin` (and nothing else) lets the parent read the height;
 * scripts still cannot run because allow-scripts is absent, and the HTML
 * was sanitised server-side before it got here.
 */
export function MessageBody({ main, quoted, compact }: { main: string; quoted: string | null; compact?: boolean }) {
  const [showQuoted, setShowQuoted] = useState(false);
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
        if (h > 0) setHeight(Math.min(h + 4, 4000));
      } catch {
        /* cross-origin fallback: keep the default height */
      }
    };
    const onLoad = () => {
      measure();
      // Images load after the document does; re-measure a few times.
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
  }, [doc]);

  return (
    <div>
      <iframe
        ref={ref}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        title="Message"
        scrolling="no"
        style={{ width: '100%', height, border: 0, borderRadius: 6, background: '#fff', display: 'block' }}
      />
      {quoted && (
        <button onClick={() => setShowQuoted((v) => !v)} className="mt-1 text-[11px] text-muted-foreground hover:text-foreground">
          {showQuoted ? 'Hide quoted text' : '··· Show quoted text'}
        </button>
      )}
    </div>
  );
}
