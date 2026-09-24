import { createHmac } from 'crypto';
import { appBaseUrl } from '@/lib/app-url';
import { autoLinkPlainUrls, rewriteLinks } from '@/lib/email/links';

const KEY = process.env.ENCRYPTION_KEY ?? 'dev-tracking-key-32chars-padding!!';

export interface TrackingPayload {
  campaignId: string;
  emailJobId: string;
  email: string;
}

function sign(data: string): string {
  return createHmac('sha256', KEY).update(data).digest('hex').slice(0, 16);
}

export function encodeTrackingToken(payload: TrackingPayload): string {
  const data = JSON.stringify(payload);
  const b64 = Buffer.from(data).toString('base64url');
  const sig = sign(b64);
  return `${b64}.${sig}`;
}

export function decodeTrackingToken(token: string): TrackingPayload | null {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const b64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (sign(b64) !== sig) return null;
    return JSON.parse(Buffer.from(b64, 'base64url').toString()) as TrackingPayload;
  } catch {
    return null;
  }
}

export function encodeUnsubToken(workspaceId: string, email: string): string {
  const data = JSON.stringify({ workspaceId, email });
  const b64 = Buffer.from(data).toString('base64url');
  const sig = sign(b64);
  return `${b64}.${sig}`;
}

export function decodeUnsubToken(token: string): { workspaceId: string; email: string } | null {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const b64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (sign(b64) !== sig) return null;
    return JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch {
    return null;
  }
}

export function buildTrackingPixelUrl(payload: TrackingPayload): string {
  return `${appBaseUrl()}/api/track/open/${encodeTrackingToken(payload)}`;
}

/**
 * Signs the destination together with the token, so a tracking link can only
 * ever redirect to the URL that was in the email (not an open redirect).
 */
export function signClickDestination(token: string, destinationUrl: string): string {
  return sign(`${token}|${destinationUrl}`);
}

export function isValidClickDestination(token: string, destinationUrl: string, signature: string | null): boolean {
  return !!signature && signClickDestination(token, destinationUrl) === signature;
}

export function buildClickTrackingUrl(payload: TrackingPayload, destinationUrl: string): string {
  const token = encodeTrackingToken(payload);
  const params = new URLSearchParams({ u: destinationUrl, s: signClickDestination(token, destinationUrl) });
  return `${appBaseUrl()}/api/track/click/${token}?${params.toString()}`;
}

export function buildUnsubscribeUrl(workspaceId: string, email: string): string {
  return `${appBaseUrl()}/unsubscribe/${encodeUnsubToken(workspaceId, email)}`;
}

/** Links that must reach us directly (unsubscribe), never through click tracking. */
function isOwnUnsubscribeLink(url: string): boolean {
  return url.startsWith(`${appBaseUrl()}/`) && /\/(api\/)?unsubscribe\//.test(url);
}

/** Inject a 1×1 tracking pixel + wrap all href links in the HTML body. */
export function injectTracking(html: string, payload: TrackingPayload, workspaceId: string): string {
  const pixelUrl = buildTrackingPixelUrl(payload);
  const unsubUrl = buildUnsubscribeUrl(workspaceId, payload.email);

  // Wrap every <a href="..."> so we track clicks (skip mailto: and already-wrapped links).
  // Plain URLs become links, scheme-less hrefs get https://, then every web
  // link is routed through click tracking (unsubscribe stays direct).
  let tracked = rewriteLinks(autoLinkPlainUrls(html), (url) =>
    isOwnUnsubscribeLink(url) ? url : buildClickTrackingUrl(payload, url),
  );

  // Append the tracking pixel just before </body> (or at the end if no body tag).
  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
  if (tracked.toLowerCase().includes('</body>')) {
    tracked = tracked.replace(/<\/body>/i, `${pixel}</body>`);
  } else {
    tracked += pixel;
  }

  // Add unsubscribe footer if not already present.
  const unsubFooter = `<p style="margin-top:24px;font-size:11px;color:#999;text-align:center;">
    <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a> from these emails.
  </p>`;
  if (!tracked.includes('/unsubscribe/')) {
    if (tracked.toLowerCase().includes('</body>')) {
      tracked = tracked.replace(/<\/body>/i, `${unsubFooter}</body>`);
    } else {
      tracked += unsubFooter;
    }
  }

  return tracked;
}
