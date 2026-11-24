import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api/respond';
import { requireSession } from '@/lib/auth/session';
import { dayKey } from '@/lib/loading/clean';
import { getDailyLines } from '@/lib/loading/daily';

/**
 * Today's fresh loading-screen lines (one AI call a day for everyone, see lib/loading/daily.ts).
 * Signed-in people only, so the AI is never reachable from outside. `empty: true` means there are none
 * (AI off or not answering): the browser keeps the built-in lines and asks again in half an hour.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = withErrorHandling(async () => {
  await requireSession({ allowLocked: true }); // cosmetic: the loading screen's words
  const daily = await getDailyLines();
  const body = daily ?? { date: dayKey(), empty: true };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'private, max-age=300' } });
});
