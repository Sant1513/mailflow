/**
 * Telling people from machines in open/click tracking. Corporate and college mail systems run
 * link scanners (Microsoft Safe Links, Mimecast, Proofpoint, Barracuda…) that "click" every link
 * the moment a message arrives, and chat apps fetch links to build previews. Counted as real,
 * they make a campaign look far more engaging than it is. Every hit is still stored; automated
 * ones are flagged and left out of open/click numbers.
 *
 * Gmail's image proxy ("GoogleImageProxy") is NOT a bot: Gmail fetches images when the person
 * opens the email, so it is a real open.
 */

const AUTOMATED_AGENTS: [RegExp, string][] = [
  [/safelinks|microsoft office|ms-office|outlook-ios-linkpreview|bingpreview|microsoft-?defender/i, 'Microsoft link scanner'],
  [/barracuda|proofpoint|urldefense|mimecast|symantec|trend ?micro|fortiguard|forcepoint|sophos|ironport|cisco|zscaler|checkpoint|cloudmark|spamhaus/i, 'email security scanner'],
  [/slackbot|facebookexternalhit|whatsapp|telegrambot|skypeuripreview|discordbot|linkedinbot|twitterbot|embedly|iframely/i, 'chat app link preview'],
  [/headlesschrome|phantomjs|puppeteer|playwright|selenium/i, 'headless browser'],
  [/python-requests|python-urllib|aiohttp|curl\/|wget|go-http-client|java\/|okhttp|apache-httpclient|axios|node-fetch|undici|libwww|httpclient/i, 'script or server'],
  [/\b(bot|crawler|spider|scanner|preview|monitor|checker|validator)\b/i, 'bot'],
];

/** A click this soon after the email was sent is a scanner, not a person. */
export const CLICK_TOO_FAST_MS = 15_000;
/** An open this soon after sending is a prefetch. */
export const OPEN_TOO_FAST_MS = 5_000;
/** Different links clicked within this window: a scanner clicking everything. */
export const CLICK_BURST_MS = 5_000;

export interface TrackingHit {
  type: 'OPEN' | 'CLICK';
  userAgent: string | null;
  /** When the email was sent; null if unknown. */
  sentAt: Date | null;
  at: Date;
}

/** Returns the reason the hit looks automated, or null for a person. */
export function automatedReason(hit: TrackingHit): string | null {
  const ua = hit.userAgent?.trim() ?? '';
  if (!ua) return 'no browser identification';
  if (/googleimageproxy/i.test(ua)) return null; // Gmail opening images for the reader
  for (const [pattern, reason] of AUTOMATED_AGENTS) if (pattern.test(ua)) return reason;
  if (hit.sentAt) {
    const age = hit.at.getTime() - hit.sentAt.getTime();
    if (hit.type === 'CLICK' && age >= 0 && age < CLICK_TOO_FAST_MS) return 'clicked within seconds of delivery';
    if (hit.type === 'OPEN' && age >= 0 && age < OPEN_TOO_FAST_MS) return 'opened within seconds of delivery';
  }
  return null;
}

/** Where open/click numbers count people only. Spread into Prisma `where` clauses. */
export const HUMAN_ONLY = { automated: false } as const;
