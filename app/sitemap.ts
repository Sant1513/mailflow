import type { MetadataRoute } from 'next';
import { appBaseUrl } from '@/lib/app-url';

/** The landing page is the only public, indexable page. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${appBaseUrl()}/`, changeFrequency: 'weekly', priority: 1 }];
}
