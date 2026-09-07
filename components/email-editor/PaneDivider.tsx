'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const MIN = 200;
const MAX = 900;

/**
 * Remembers the left/right pane widths of a three-pane editor per browser
 * and clamps them so the middle pane can never be squeezed away.
 */
export function usePaneWidths(storageKey: string, defaults: { left: number; right: number }) {
  const [widths, setWidths] = useState(defaults);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.left === 'number' && typeof parsed.right === 'number') {
          setWidths({ left: clamp(parsed.left), right: clamp(parsed.right) });
        }
      }
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  const resize = useCallback(
    (side: 'left' | 'right', dx: number) => {
      setWidths((w) => {
        const next = { ...w, [side]: clamp(w[side] + dx) };
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [storageKey]
  );

  return { widths, resize };
}

function clamp(n: number) {
  return Math.min(MAX, Math.max(MIN, Math.round(n)));
}

/** A vertical drag handle; calls onDrag with the pointer delta since the last move. Hidden below lg. */
export function PaneDivider({ onDrag }: { onDrag: (dx: number) => void }) {
  const lastX = useRef<number | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    function move(e: MouseEvent) {
      if (lastX.current === null) return;
      onDrag(e.clientX - lastX.current);
      lastX.current = e.clientX;
    }
    function up() {
      if (lastX.current === null) return;
      lastX.current = null;
      setActive(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [onDrag]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize"
      onMouseDown={(e) => {
        e.preventDefault();
        lastX.current = e.clientX;
        setActive(true);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      className={`hidden w-1.5 shrink-0 cursor-col-resize transition lg:block ${active ? 'bg-primary' : 'bg-border hover:bg-primary/60'}`}
    />
  );
}
