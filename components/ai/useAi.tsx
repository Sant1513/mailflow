'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Client side of /api/ai. Every call resolves — never throws — to the
 * server's AiOutcome so panels can show "continue manually" copy (§82)
 * instead of an error state.
 */

export type AiOutcome<T> =
  | { ok: true; data: T; usage: { totalTokens: number; latencyMs: number; userToday: number; userLimit: number } }
  | { ok: false; code: string; message: string };

export async function callAi<T>(body: Record<string, unknown>): Promise<AiOutcome<T>> {
  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, code: String(res.status), message: json?.error ?? `Request failed (${res.status})` };
    }
    return json as AiOutcome<T>;
  } catch (err) {
    return { ok: false, code: 'NETWORK', message: (err as Error).message || 'Network error' };
  }
}

export interface AiStatusInfo {
  enabled: boolean;
  configured: boolean;
  model: string | null;
  usage: { userToday: number; userLimit: number; orgToday: number; orgLimit: number };
}

/** "AI usage today: 42 / 100" plus on/off, refreshed after every call via `bump`. */
export function useAiStatus() {
  const [status, setStatus] = useState<AiStatusInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/ai');
      if (res.ok) setStatus(await res.json());
    } catch {
      /* leave previous state */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Optimistically reflect a successful call's reported count. */
  const bump = useCallback((userToday: number) => {
    setStatus((s) => (s ? { ...s, usage: { ...s.usage, userToday } } : s));
  }, []);

  return { status, refresh, bump };
}

export function UsageLine({ status }: { status: AiStatusInfo | null }) {
  if (!status) return null;
  if (!status.enabled) {
    return <span className="text-xs text-faint">AI is {status.configured ? 'turned off' : 'not configured'} for this deployment.</span>;
  }
  const near = status.usage.userToday >= status.usage.userLimit * 0.8;
  return (
    <span className={`text-xs ${near ? 'text-warning' : 'text-faint'}`}>
      AI usage today: {status.usage.userToday} / {status.usage.userLimit}
    </span>
  );
}
