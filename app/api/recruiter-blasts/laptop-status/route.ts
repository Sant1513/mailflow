import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api/respond';
import { requireBlastReader } from '@/lib/recruiterSend/access';
import { currentState, laptopOnline } from '@/lib/system/serverState';

/**
 * Can a recruiter send go out from the laptop right now? For the "Send from" choice on the send
 * page (admins; Settings → Server's own status is super-admin only). Only what the choice needs:
 * no laptop address.
 */
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  await requireBlastReader();
  const s = await currentState();
  return NextResponse.json(
    { laptopOnline: laptopOnline(s), activeServer: s.activeServer === 'laptop' ? 'laptop' : 'cloud', lastLaptopSeenAt: s.lastLaptopSeenAt },
    { headers: { 'cache-control': 'no-store' } },
  );
});
