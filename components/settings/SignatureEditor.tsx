'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Lets the current user write and save an email signature. */
export function SignatureEditor() {
  const [signature, setSignature] = useState('');
  const [original, setOriginal] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/profile')
      .then((r) => r.json())
      .then((j) => {
        setSignature(j.user.emailSignature ?? '');
        setOriginal(j.user.emailSignature ?? '');
      })
      .catch(() => undefined);
  }, []);

  async function save() {
    setBusy(true);
    const res = await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailSignature: signature.trim() || null }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error('Failed to save signature');
      return;
    }
    const j = await res.json();
    const saved = j.user.emailSignature ?? '';
    setSignature(saved);
    setOriginal(saved);
    toast.success('Signature saved');
  }

  const dirty = signature !== original;

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        Appended automatically at the bottom of every reply you compose.
        Plain text; blank lines become paragraph breaks.
      </p>
      <textarea
        value={signature}
        onChange={(e) => setSignature(e.target.value)}
        rows={5}
        placeholder={'e.g.\n\nBest,\nYour Name\nTitle · Company'}
        className="w-full rounded border bg-background px-2 py-1.5 text-sm"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="btn-primary"
        >
          {busy ? 'Saving…' : 'Save signature'}
        </button>
        {dirty && (
          <button onClick={() => setSignature(original)} className="btn-secondary">
            Discard
          </button>
        )}
      </div>
    </div>
  );
}
