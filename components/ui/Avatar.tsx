'use client';

import { useEffect, useState } from 'react';

/**
 * A person's avatar: their Google profile photo when we have one (lib/profilePhotos, from the
 * mailboxes' Other contacts), otherwise coloured initials. Lookups from every avatar on the page
 * are batched into one request and cached for the visit; a photo that fails to load falls back
 * to initials.
 */

const cache = new Map<string, string | null>(); // email -> url (null = none)
const waiting = new Map<string, ((url: string | null) => void)[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const emails = [...waiting.keys()].filter((e) => !cache.has(e)).slice(0, 300);
  if (!emails.length) return;
  fetch('/api/profile-photos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emails }) })
    .then((r) => (r.ok ? r.json() : { photos: {} }))
    .catch(() => ({ photos: {} }))
    .then((j: { photos?: Record<string, string> }) => {
      for (const e of emails) {
        const url = j.photos?.[e] ?? null;
        cache.set(e, url);
        for (const cb of waiting.get(e) ?? []) cb(url);
        waiting.delete(e);
      }
      if (waiting.size) timer = setTimeout(flush, 30); // more arrived while this was in flight
    });
}

function lookup(email: string, cb: (url: string | null) => void) {
  if (cache.has(email)) return cb(cache.get(email) ?? null);
  const list = waiting.get(email) ?? [];
  list.push(cb);
  waiting.set(email, list);
  if (!timer) timer = setTimeout(flush, 40);
}

export function initialsOf(name?: string | null, email?: string | null): string {
  const source = (name?.trim() || (email ?? '?').split('@')[0] || '?').replace(/[^\p{L}\p{N}\s._-]/gu, '');
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + second).toUpperCase();
}

// Soft, readable colour pairs, picked from the address so a person keeps their colour.
const TONES = [
  'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  'bg-orange-500/15 text-orange-600 dark:text-orange-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
];
function toneFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length]!;
}

export function Avatar({ email, name, size = 32, className = '' }: { email?: string | null; name?: string | null; size?: number; className?: string }) {
  const key = (email ?? '').trim().toLowerCase();
  const [url, setUrl] = useState<string | null>(() => (key && cache.has(key) ? cache.get(key) ?? null : null));
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
    if (!key.includes('@')) return setUrl(null);
    let live = true;
    lookup(key, (u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [key]);

  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.36)) };
  if (url && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Google's photo CDN, small and already sized
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full object-cover ring-1 ring-border-subtle ${className}`}
        style={style}
      />
    );
  }
  return (
    <span aria-hidden className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ${toneFor(key || name || '?')} ${className}`} style={style}>
      {initialsOf(name, email)}
    </span>
  );
}
