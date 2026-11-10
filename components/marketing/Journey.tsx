'use client';

import { useEffect, useRef, useState } from 'react';
import { ApproveVisual, ConnectVisual, DataVisual, InboxVisual, SendingVisual, SigningVisual } from './DeepDiveVisuals';

type Stop = {
  id: string;
  label: string;
  meta: string;
  chip: string;
  line1: string;
  line2: string;
  copy: string;
  points: string[];
  visual: React.ReactNode;
};

const STOPS: Stop[] = [
  {
    id: 'flow-connect',
    label: 'Connect',
    meta: 'Gmail · 1 min',
    chip: 'Step 01 · Gmail',
    line1: 'Sign in with Google.',
    line2: 'Send as yourself.',
    copy: 'Connect the mailbox you already send from. Emails leave from your own address, land in your Sent folder, and replies come back to a real person.',
    points: ['No shared "noreply" address.', 'Gmail tokens encrypted at rest (AES-256-GCM), never sent to the browser.', 'Opt in to lend your mailbox as a backup sender for teammates.'],
    visual: <ConnectVisual />,
  },
  {
    id: 'flow-data',
    label: 'Bring data',
    meta: 'Sheets · CSV · segments',
    chip: 'Step 02 · Your data',
    line1: 'Start from your sheet.',
    line2: 'Every column is a field.',
    copy: 'Upload a CSV or Excel file, paste a list, link a Google Sheet that syncs both ways, or pick a saved segment. Every column becomes a {{field}} you can write with.',
    points: ['Google Sheets two-way sync, hourly or on "Sync now".', 'Recruiter Bulk Send fills empty values with {{Column | fallback}}.', 'Contacts are resolved and deduplicated on import.'],
    visual: <DataVisual />,
  },
  {
    id: 'flow-approve',
    label: 'Check & approve',
    meta: 'Dry run · approval',
    chip: 'Step 03 · Before it sends',
    line1: 'See who gets what.',
    line2: 'Then sign it off.',
    copy: 'A dry run uses the same rules as the real send, so you know who receives which email, and who is skipped and why, before anything goes out.',
    points: ['Unsubscribed, bounced, dead-domain, typo and no-reply addresses are skipped with the reason.', 'Campaigns from non-admins wait in Approvals until an admin approves.', 'Send yourself a test first.'],
    visual: <ApproveVisual />,
  },
  {
    id: 'flow-send',
    label: 'Send',
    meta: '3 s pace · backups',
    chip: 'Step 04 · Safe sending',
    line1: 'Big batches.',
    line2: 'Inside Google’s limits.',
    copy: 'MailFlow paces every mailbox so a large send never trips Gmail, and keeps going on its own even with the tab closed.',
    points: ['One email every 3 seconds per mailbox.', 'Each mailbox stops at 1,500 emails per rolling 24 hours, below Google’s 2,000.', 'Backup mailboxes take over at the limit and hand back when it frees up.'],
    visual: <SendingVisual />,
  },
  {
    id: 'flow-replies',
    label: 'Replies',
    meta: 'Inbox · AI triage',
    chip: 'Step 05 · The inbox',
    line1: 'Every reply comes back.',
    line2: 'To the record it belongs to.',
    copy: 'Replies, bounces and out-of-office messages are threaded to the campaign and record they came from, in one shared inbox.',
    points: ['Assign, tag, add internal notes; SLA timers flag what is overdue.', 'AI triage sorts human replies and drafts an answer. Nothing is sent until you approve it.', 'Bounced addresses are suppressed across the organisation.'],
    visual: <InboxVisual />,
  },
  {
    id: 'flow-sign',
    label: 'Sign',
    meta: 'Bulk · in order',
    chip: 'Step 06 · MailFlow Sign',
    line1: 'One agreement.',
    line2: 'A whole batch signed.',
    copy: 'Turn a Word file or Google Doc into a template, send it to a batch, and track every signer until it is done.',
    points: ['Up to 3 signers per document, in order or in parallel.', 'Automatic reminders and live statuses.', 'Signed PDF with a certificate of completion; the status is written back to the row.'],
    visual: <SigningVisual />,
  },
];

/**
 * "The MailFlow flow": a sticky rail of stops on the left (a chip row under the nav on smaller
 * screens) and one panel per stop on the right. The stop whose panel is in view is highlighted
 * (IntersectionObserver scrollspy); clicking a stop scrolls to its panel.
 */
export function Journey() {
  const [active, setActive] = useState(STOPS[0]!.id);
  const railRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    const ratios = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratios.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        let best: string | null = null;
        let bestRatio = 0;
        for (const s of STOPS) {
          const r = ratios.get(s.id) ?? 0;
          if (r > bestRatio) {
            best = s.id;
            bestRatio = r;
          }
        }
        if (best) setActive(best);
      },
      // A band across the middle of the screen decides which panel is "current".
      { rootMargin: '-35% 0px -45% 0px', threshold: [0, 0.01, 0.25, 0.5, 0.75, 1] },
    );
    STOPS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, []);

  // On the chip row, keep the active chip in view (horizontal scroll only; never moves the page).
  useEffect(() => {
    const rail = railRef.current;
    const chip = rail?.querySelector<HTMLElement>(`[data-stop="${active}"]`);
    if (!rail || !chip || rail.scrollWidth <= rail.clientWidth) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rail.scrollTo({ left: chip.offsetLeft - 16, behavior: reduce ? 'auto' : 'smooth' });
  }, [active]);

  return (
    <div className="jr-body">
      <nav className="jr-rail" aria-label="The MailFlow flow">
        <ol ref={railRef}>
          {STOPS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} data-stop={s.id} className="jr-stop" aria-current={active === s.id ? 'step' : undefined}>
                <span>
                  <span className="jr-stop-label">{s.label}</span>
                  <span className="jr-stop-meta">{s.meta}</span>
                </span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="jr-panels">
        {STOPS.map((s) => (
          <article key={s.id} id={s.id} className="jr-panel" aria-labelledby={`${s.id}-title`}>
            <div className="grid items-center gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
              <div data-r="l">
                <span className="jr-chip">{s.chip}</span>
                <h3 id={`${s.id}-title`} className="jr-title">
                  {s.line1}
                  <span>{s.line2}</span>
                </h3>
                <p className="jr-copy">{s.copy}</p>
                <ul className="jr-points">
                  {s.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
              <div data-r="r" style={{ ['--d' as string]: '70ms' }} className="min-w-0">
                {s.visual}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
