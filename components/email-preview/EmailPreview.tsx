'use client';

/**
 * §23/§25: renders preview HTML inside a sandboxed iframe. The `sandbox`
 * attribute with no `allow-scripts` means no JavaScript in the previewed
 * HTML can ever execute, and `srcDoc` keeps it off our origin. The server
 * has already sanitized the markup (lib/templates/sanitize.ts) — this is
 * the second layer.
 */
export function EmailPreview({
  html,
  mode,
}: {
  html: string;
  mode: 'desktop' | 'mobile';
}) {
  const width = mode === 'mobile' ? 375 : 700;

  return (
    <div className="flex justify-center overflow-auto bg-muted/40 p-4">
      <iframe
        // No allow-scripts: JavaScript in a template can never run here.
        sandbox=""
        srcDoc={html}
        title="Email preview"
        style={{ width, height: '100%', minHeight: 480, border: '1px solid hsl(var(--border))', borderRadius: 6, background: '#fff' }}
      />
    </div>
  );
}
