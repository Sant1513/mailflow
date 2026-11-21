import { Prisma } from '@prisma/client';
import { z } from 'zod';

/**
 * Pure helpers shared by Contacts and Data for "Last emailed", the "Recently emailed" filter and the cool-off editor.
 * The lookups themselves live in lib/recruiterSend/recent.ts (matching people by emailKey).
 */

export const RECENT_DAY_CHOICES = [3, 7, 10, 30] as const;
export const DEFAULT_RECENT_DAYS = 10;
const DAY_MS = 86_400_000;

export type EmailedMode = 'any' | 'within' | 'not';
export interface EmailedFilter { mode: EmailedMode; days: number }

/** ?emailed=any|within|not&emailedDays=3|7|10|30 (anything else falls back to Any / 10). */
export function parseEmailedFilter(params: URLSearchParams): EmailedFilter {
  const raw = params.get('emailed');
  const mode: EmailedMode = raw === 'within' || raw === 'not' ? raw : 'any';
  const d = Number(params.get('emailedDays'));
  const days = (RECENT_DAY_CHOICES as readonly number[]).includes(d) ? d : DEFAULT_RECENT_DAYS;
  return { mode, days };
}

export function emailedQuery(f: EmailedFilter): string {
  return f.mode === 'any' ? '' : `&emailed=${f.mode}&emailedDays=${f.days}`;
}

/**
 * SQL condition on a person's emailKey. null = no restriction. People without an email never count as emailed,
 * so "not emailed" keeps them. `expr` must be a text expression for the address (e.g. the contact's primaryEmail).
 */
export function emailedCondition(expr: Prisma.Sql, mode: EmailedMode, keys: string[]): Prisma.Sql | null {
  if (mode === 'any') return null;
  if (mode === 'within') {
    if (!keys.length) return Prisma.sql`FALSE`;
    return Prisma.sql`COALESCE(mailflow_email_key(${expr}) = ANY(${keys}::text[]), FALSE)`;
  }
  if (!keys.length) return null;
  return Prisma.sql`NOT COALESCE(mailflow_email_key(${expr}) = ANY(${keys}::text[]), FALSE)`;
}

/** Escapes % _ and \ for ILIKE, wrapped for "contains". */
export function likeContains(text: string): string {
  return `%${text.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface LastEmailedInfo { at: string; subject: string; source: string; from: string | null }

export function toLastEmailedInfo(e: { at: Date; subject: string; source: string; from: string | null } | undefined): LastEmailedInfo | null {
  return e ? { at: e.at.toISOString(), subject: e.subject, source: e.source, from: e.from } : null;
}

/** "today", "yesterday", "3 days ago", "5 weeks ago", "4 months ago". */
export function relativeDays(atIso: string, now = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(atIso).getTime()) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** Text for the "Last emailed" cell: a main line and a tooltip with the subject and source. */
export function lastEmailedText(info: LastEmailedInfo | null | undefined, now = new Date()): { label: string; title: string; never: boolean } {
  if (!info) return { label: 'Never emailed from MailFlow', title: 'No email from MailFlow in the last year', never: true };
  const subject = info.subject.length > 90 ? `${info.subject.slice(0, 87)}…` : info.subject;
  return {
    label: relativeDays(info.at, now),
    title: `${info.subject ? `“${subject}” · ` : ''}${info.source}${info.from ? ` · from ${info.from}` : ''}`,
    never: false,
  };
}

/* ---------------- cool-off ---------------- */

export const COOL_OFF_MAX_DAYS = 2 * 365;
export const COOL_OFF_NOTE_MAX = 200;

/** "2026-11-28" -> midnight at the start of that day in India (the app's display zone), or null when it is not a real date. */
export function parseCoolOffDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return null;
  // Rejects 2026-02-31 (JS would roll it over to March).
  if (new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10) !== s) return null;
  return d;
}

export const coolOffBodySchema = z
  .object({
    doNotContactUntil: z.string().nullable(),
    coolOffNote: z.string().max(COOL_OFF_NOTE_MAX).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.doNotContactUntil === null) return;
    const d = parseCoolOffDate(v.doNotContactUntil);
    if (!d) return ctx.addIssue({ code: 'custom', path: ['doNotContactUntil'], message: 'Choose a valid date.' });
    if (d.getTime() - Date.now() > COOL_OFF_MAX_DAYS * DAY_MS) {
      ctx.addIssue({ code: 'custom', path: ['doNotContactUntil'], message: 'The date can be at most 2 years ahead.' });
    }
  });

export function coolOffBadgeText(until: Date | string): string {
  const d = new Date(until);
  const day = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  return `Do not contact until ${day}`;
}

/** The value for <input type="date"> (India date of the stored moment). */
export function coolOffInputValue(until: Date | string | null | undefined): string {
  if (!until) return '';
  return new Date(new Date(until).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

export function isCoolingOff(until: Date | string | null | undefined, now = new Date()): boolean {
  return !!until && new Date(until).getTime() > now.getTime();
}
