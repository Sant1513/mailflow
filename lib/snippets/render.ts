import { escapeHtml } from '@/lib/templates/variables';

/**
 * §4.1 saved replies. Variables resolve against the conversation's contact
 * and record so "Hi {{Name}}" becomes "Hi Rahul" at insert time. Unknown or
 * empty variables are left in place ({{Deadline}}) so the sender sees what
 * still needs a value before sending — the composer highlights them.
 */
export interface SnippetContext {
  contactName?: string | null;
  contactEmail?: string | null;
  senderName?: string | null;
  record?: Record<string, unknown> | null;
}

const VARIABLE_RE = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_ ]*?)\s*\}\}/g;

export function snippetVariables(ctx: SnippetContext): Record<string, unknown> {
  const first = (ctx.contactName ?? '').trim().split(/\s+/)[0] ?? '';
  return {
    ...(ctx.record ?? {}),
    Name: ctx.contactName || ctx.record?.Name || '',
    FirstName: first,
    Email: ctx.contactEmail || ctx.record?.Email || '',
    Sender: ctx.senderName ?? '',
  };
}

export function renderSnippet(html: string, ctx: SnippetContext): { html: string; missing: string[] } {
  const vars = snippetVariables(ctx);
  const missing = new Set<string>();
  const out = html.replace(VARIABLE_RE, (full, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      missing.add(name);
      return full;
    }
    return escapeHtml(String(value));
  });
  return { html: out, missing: Array.from(missing).sort() };
}
