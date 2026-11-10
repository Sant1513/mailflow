import type { MetadataRoute } from 'next';
import { appBaseUrl } from '@/lib/app-url';

/**
 * Only the landing page is public. Everything behind sign-in (the app/(app) folders), the API,
 * per-person links in emails (signing, RSVP, unsubscribe) and the sign-in flow stay out of
 * search results. Keep this list in step with the folders in app/(app).
 */
const PRIVATE = [
  '/api/',
  // app/(app)
  '/admin',
  '/approvals',
  '/automations',
  '/batches',
  '/campaigns',
  '/contacts',
  '/dashboard',
  '/data',
  '/deliverability',
  '/documents',
  '/history',
  '/inbox',
  '/mailbox-usage',
  '/performance',
  '/quick-send',
  '/recruiter-send',
  '/reports',
  '/settings',
  '/suppressions',
  '/templates',
  // signed-in or per-person pages outside the group
  '/choose',
  '/pending',
  // /login is NOT listed: it carries noindex + canonical '/', which Google can only read if it may crawl it.
  '/sign/',
  '/rsvp/',
  '/unsubscribe',
];

export default function robots(): MetadataRoute.Robots {
  const base = appBaseUrl();
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: PRIVATE }],
    sitemap: `${base}/sitemap.xml`,
  };
}
