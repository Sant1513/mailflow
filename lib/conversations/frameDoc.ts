/**
 * The document loaded into a sandboxed message frame: a white email canvas
 * with readable defaults and images capped to the frame. No script runs —
 * the frame has no allow-scripts and the HTML is sanitised server-side.
 * Client-safe (no Node-only imports) so the inbox can build it in the browser.
 */
export function frameDocument(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><base target="_blank"><style>
html,body{margin:0;padding:0;background:#fff;color:#1f2328}
body{font:14px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:14px 16px;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{max-width:100%}
blockquote{margin:8px 0 8px 8px;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a}
pre{white-space:pre-wrap}
a{color:#b8001f}
</style></head><body>${bodyHtml}</body></html>`;
}
