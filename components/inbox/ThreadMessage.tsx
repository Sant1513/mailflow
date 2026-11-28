'use client';

import { useState } from 'react';
import { ChevronDown, CornerUpLeft, Paperclip } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { MessageBody } from '@/components/inbox/MessageBody';

/**
 * One message in a conversation, the way Gmail shows it:
 *   collapsed  one line: avatar, sender, the start of the text, attachment clip, short date (click to open)
 *   expanded   sender with address, "to …" with a details toggle (from / to / cc / date), full date and how long ago,
 *              the body, attachments, and Reply
 */
export interface ThreadMsg {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  classification?: string | null;
  senderEmail: string;
  senderName?: string | null;
  recipientEmail?: string | null;
  cc?: string[];
  subject?: string | null;
  snippet?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  createdAt?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  bodyMain?: string | null;
  bodyQuoted?: string | null;
  attachments?: { id: string; filename: string; mimeType?: string; size: number; campaignDocumentId?: string | null; documentRef?: string | null }[];
}

export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ago(iso: string, now = new Date()): string {
  const m = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function ThreadMessage({
  m, mailbox, expanded, onToggle, onReply, canReply,
}: {
  m: ThreadMsg;
  /** The mailbox this conversation is in (shown as "me" on our own messages). */
  mailbox: string;
  expanded: boolean;
  onToggle: () => void;
  onReply: () => void;
  canReply: boolean;
}) {
  const [details, setDetails] = useState(false);
  const out = m.direction === 'OUTBOUND';
  const at = m.sentAt ?? m.receivedAt ?? m.createdAt ?? new Date().toISOString();
  const who = out ? 'Me' : m.senderName || m.senderEmail;
  const fromAddr = out ? mailbox : m.senderEmail;
  const flag = !out && m.classification && m.classification !== 'HUMAN_REPLY' ? m.classification.replace(/_/g, ' ').toLowerCase() : null;
  const unread = !out && m.isRead === false;

  if (!expanded) {
    return (
      <div role="button" tabIndex={0} data-message={m.id} data-state="collapsed" onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/50">
        <Avatar email={fromAddr} name={out ? null : m.senderName} size={28} />
        <span className={`w-40 shrink-0 truncate ${unread ? 'font-semibold' : 'font-medium'}`}>{who}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{flag && <span className="mr-1.5 rounded bg-warning/15 px-1 text-[10px] text-warning">{flag}</span>}{m.snippet ?? ''}</span>
        {m.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" />}
        <span className="shrink-0 text-xs text-muted-foreground">{shortDate(at)}</span>
      </div>
    );
  }

  return (
    <div data-message={m.id} data-state="expanded" className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Avatar email={fromAddr} name={out ? null : m.senderName} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <button type="button" onClick={onToggle} className="text-left text-sm font-semibold hover:underline" title="Collapse">{who}</button>
            <span className="text-xs text-muted-foreground">&lt;{fromAddr}&gt;</span>
            {flag && <span className="rounded bg-warning/15 px-1 text-[10px] text-warning">{flag}</span>}
          </div>
          <button type="button" onClick={() => setDetails((v) => !v)} aria-expanded={details} className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">
            to {out ? m.recipientEmail || 'recipient' : 'me'}{(m.cc?.length ?? 0) > 0 ? `, +${m.cc!.length} cc` : ''} <ChevronDown className={`h-3 w-3 transition ${details ? 'rotate-180' : ''}`} />
          </button>
          {details && (
            <dl className="mt-1.5 grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5 rounded-md border bg-muted/30 p-2 text-xs" data-details>
              <dt className="text-muted-foreground">from:</dt><dd><b>{who}</b> &lt;{fromAddr}&gt;</dd>
              <dt className="text-muted-foreground">to:</dt><dd>{out ? m.recipientEmail : mailbox}</dd>
              {(m.cc?.length ?? 0) > 0 && <><dt className="text-muted-foreground">cc:</dt><dd>{m.cc!.join(', ')}</dd></>}
              {m.subject && <><dt className="text-muted-foreground">subject:</dt><dd>{m.subject}</dd></>}
              <dt className="text-muted-foreground">date:</dt><dd>{new Date(at).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' })}</dd>
            </dl>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span title={new Date(at).toLocaleString()}>{new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })} ({ago(at)})</span>
          {canReply && (
            <button type="button" onClick={onReply} aria-label="Reply" title="Reply (r)" className="rounded-full p-1.5 hover:bg-muted hover:text-foreground"><CornerUpLeft className="h-4 w-4" /></button>
          )}
        </div>
      </div>
      <div className="mt-2 pl-12">
        <MessageBody main={m.bodyMain ?? '<p><em>(no text)</em></p>'} quoted={m.bodyQuoted ?? null} collapsible />
        {(m.attachments?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {m.attachments!.map((a) => {
              const label = (
                <>
                  <Paperclip className="h-3 w-3" /> <span className="max-w-[16rem] truncate">{a.filename}</span> <span className="text-faint">{Math.max(1, Math.round(a.size / 1024))} KB</span>
                </>
              );
              return a.campaignDocumentId ? (
                <a key={a.id} href={`/api/attachments/${a.id}?inline=1`} target="_blank" rel="noopener noreferrer" title={`Open the personalised PDF sent in this email${a.documentRef ? ` (${a.documentRef})` : ''}`} className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 hover:bg-muted">{label}</a>
              ) : (
                <span key={a.id} title={a.mimeType} className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1">{label}</span>
              );
            })}
          </div>
        )}
        {canReply && (
          <div className="mt-3">
            <button type="button" onClick={onReply} className="inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-sm hover:bg-muted"><CornerUpLeft className="h-4 w-4" /> Reply</button>
          </div>
        )}
      </div>
    </div>
  );
}
