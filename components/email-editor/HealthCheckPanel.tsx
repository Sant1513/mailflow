'use client';

export interface HealthCheckItem {
  id: string;
  label: string;
  level: 'pass' | 'warn' | 'fail';
  detail?: string;
}

export interface HealthCheckResult {
  items: HealthCheckItem[];
  blocked: boolean;
  failCount: number;
  warnCount: number;
}

const ICON = { pass: '✓', warn: '!', fail: '✕' } as const;
const COLOR = {
  pass: 'text-success',
  warn: 'text-warning',
  fail: 'text-primary',
} as const;

/** §27 Email Health Check results. A `fail` blocks the send (§33). */
export function HealthCheckPanel({ result, onClose }: { result: HealthCheckResult; onClose: () => void }) {
  return (
    <div className="max-h-64 shrink-0 overflow-y-auto border-t bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase text-muted-foreground">Email health check</div>
        <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
          Close
        </button>
      </div>

      <div
        className={`mb-2 rounded-md px-2 py-1.5 text-xs ${
          result.blocked ? 'bg-destructive/10 text-primary' : result.warnCount > 0 ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'
        }`}
      >
        {result.blocked
          ? `Sending is blocked — ${result.failCount} problem${result.failCount === 1 ? '' : 's'} must be fixed.`
          : result.warnCount > 0
            ? `Ready to send, with ${result.warnCount} warning${result.warnCount === 1 ? '' : 's'}.`
            : 'All checks passed.'}
      </div>

      <ul className="space-y-1">
        {result.items.map((item) => (
          <li key={item.id} className="flex gap-2 text-xs">
            <span className={`font-bold ${COLOR[item.level]}`}>{ICON[item.level]}</span>
            <span>
              <span className={item.level === 'pass' ? '' : 'font-medium'}>{item.label}</span>
              {item.detail && <span className="text-muted-foreground"> — {item.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
