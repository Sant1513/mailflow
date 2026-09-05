'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

interface GmailAccount {
  id: string;
  emailAddress: string;
  status: string;
  lastVerifiedAt: string | null;
  scope: string | null;
}

/** §29 Settings → Gmail. Tokens are never sent to the browser. */
export function GmailPanel() {
  const params = useSearchParams();
  const [account, setAccount] = useState<GmailAccount | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const res = await fetch('/api/gmail/status');
    const json = await res.json();
    setAccount(json.account ?? null);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  // Surface the outcome of the OAuth round-trip.
  useEffect(() => {
    const ok = params.get('gmail');
    const error = params.get('gmailError');
    if (ok?.startsWith('connected:')) toast.success(`Gmail connected: ${ok.slice('connected:'.length)}`);
    // A connection failure can carry an instruction with a URL in it (e.g.
    // "enable the Gmail API at ..."), so it must stay on screen until
    // dismissed — a 4-second toast is not enough time to read, let alone
    // act on, a link.
    if (error) toast.error(error, { duration: Infinity, closeButton: true });
  }, [params]);

  async function disconnect() {
    if (!confirm('Disconnect Gmail? Campaigns will not be able to send until you reconnect.')) return;
    const res = await fetch('/api/gmail/status', { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Failed to disconnect');
      return;
    }
    toast.success('Gmail disconnected');
    load();
  }

  if (loading) return <div className="text-sm text-muted-foreground">Checking Gmail connection…</div>;

  const connected = account?.status === 'CONNECTED';

  return (
    <div>
      {account ? (
        <div className="mb-3 rounded-md border bg-muted/40 p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className={connected ? 'text-green-700' : 'text-amber-700'}>
              {connected ? '✓ Connected' : `⚠ ${account.status}`}
            </span>
            <span className="font-medium">{account.emailAddress}</span>
          </div>
          {account.lastVerifiedAt && (
            <div className="mt-1 text-xs text-muted-foreground">
              Last verified: {new Date(account.lastVerifiedAt).toLocaleString()}
            </div>
          )}
          {!connected && (
            <div className="mt-2 text-xs text-amber-800">
              This connection needs to be re-authorized before campaigns can send.
            </div>
          )}
        </div>
      ) : (
        <p className="mb-3 text-sm text-muted-foreground">No Gmail account connected yet.</p>
      )}

      <div className="flex gap-2">
        <a
          href="/api/gmail/connect"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          {account ? 'Reconnect' : 'Connect Gmail'}
        </a>
        {account && (
          <button onClick={disconnect} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
            Disconnect
          </button>
        )}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Campaigns send from your own @masaischool.com address — never a shared &quot;noreply@&quot; sender.
        MailFlow stores encrypted OAuth tokens only; it never sees your password.
      </p>
    </div>
  );
}
