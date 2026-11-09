import type { ReactNode } from 'react';

/**
 * The top of every page, in the same style as the dashboard: an optional eyebrow, the title in
 * the heading font, a short description, and actions on the right (wrapping under on phones).
 */
export function PageHeader({ eyebrow, title, description, actions, className = '' }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={`mb-6 flex flex-wrap items-end justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
