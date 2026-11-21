'use client';

import {
  RECENT_DAY_CHOICES,
  coolOffBadgeText,
  lastEmailedText,
  type EmailedFilter,
  type EmailedMode,
  type LastEmailedInfo,
} from '@/lib/contacts/recentEmailed';

/** "Recently emailed": Any / Emailed in the last N days / Not emailed in the last N days. */
export function RecentlyEmailedFilter({ value, onChange }: { value: EmailedFilter; onChange: (v: EmailedFilter) => void }) {
  return (
    <span className="flex items-center gap-1">
      <select
        value={value.mode}
        onChange={(e) => onChange({ ...value, mode: e.target.value as EmailedMode })}
        className={`!w-auto !py-1.5 text-xs ${value.mode !== 'any' ? '!border-primary' : ''}`}
        title="Recently emailed from MailFlow (campaigns, recruiter sends and Inbox replies)"
        aria-label="Recently emailed"
      >
        <option value="any">Recently emailed: any</option>
        <option value="within">Emailed in the last…</option>
        <option value="not">Not emailed in the last…</option>
      </select>
      {value.mode !== 'any' && (
        <select
          value={value.days}
          onChange={(e) => onChange({ ...value, days: Number(e.target.value) })}
          className="!w-auto !py-1.5 text-xs"
          aria-label="Number of days"
        >
          {RECENT_DAY_CHOICES.map((d) => (
            <option key={d} value={d}>{d} days</option>
          ))}
        </select>
      )}
    </span>
  );
}

/** "3 days ago" with the subject and source as the tooltip; muted when never emailed. */
export function LastEmailedCell({ info, compact = false }: { info: LastEmailedInfo | null | undefined; compact?: boolean }) {
  const t = lastEmailedText(info);
  return (
    <span className={`block truncate text-xs ${t.never ? 'text-muted-foreground' : ''}`} title={t.title}>
      {t.label}
      {!t.never && !compact && <span className="block truncate text-[10px] text-muted-foreground">{t.title}</span>}
    </span>
  );
}

export function CoolOffBadge({ until }: { until: string | Date }) {
  return <span className="inline-block rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">{coolOffBadgeText(until)}</span>;
}
