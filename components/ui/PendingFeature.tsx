/**
 * §140: "No fake functionality" — a feature that isn't wired up yet must say
 * so plainly instead of showing fake data or a silently-broken UI. Every
 * page using this is tracked in PHASE_STATUS.md.
 */
export function PendingFeature({ title, phase, note }: { title: string; phase: string; note?: string }) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-dashed p-8 text-center">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <div className="mb-1 text-sm text-muted-foreground">Not yet implemented — planned in {phase}.</div>
      {note && <div className="text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}
