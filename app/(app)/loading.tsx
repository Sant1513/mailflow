import { LoadingScreen } from '@/components/loading/LoadingScreen';

/**
 * Shown by Next.js while any app page loads. The same smart loading screen as the pages' own data waits
 * (it hands over to theirs without restarting), so the screen never sits blank.
 */
export default function Loading() {
  return <LoadingScreen label="Loading" />;
}
