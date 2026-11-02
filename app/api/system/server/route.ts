import { NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { controlDb, currentState, laptopOnline, type ServerName } from '@/lib/system/serverState';

// Settings → Server: which server MailFlow runs on, and the switch (super admins only).
export const dynamic = 'force-dynamic';

function view(s: Awaited<ReturnType<typeof currentState>>) {
  return {
    activeServer: s.activeServer as ServerName,
    switchTo: s.switchTo as ServerName | null,
    switchStartedAt: s.switchStartedAt,
    switchRequestedBy: s.switchRequestedBy,
    lastSyncAt: s.lastSyncAt,
    lastLaptopSeenAt: s.lastLaptopSeenAt,
    laptopOnline: laptopOnline(s),
    note: s.note,
  };
}

export const GET = withErrorHandling(async () => {
  await requireRole([Role.SUPER_ADMIN]);
  return NextResponse.json(view(await currentState()));
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const body = (await req.json().catch(() => ({}))) as { to?: string; emergency?: boolean };
  const to = body.to === 'laptop' || body.to === 'cloud' ? body.to : null;
  if (!to) return NextResponse.json({ error: 'Choose "cloud" or "laptop".' }, { status: 400 });

  const s = await currentState();
  if (s.switchTo) return NextResponse.json({ error: 'A switch is already in progress.' }, { status: 409 });
  if (s.activeServer === to) return NextResponse.json({ error: `MailFlow is already on the ${to}.` }, { status: 400 });
  if (to === 'laptop' && !laptopOnline(s)) {
    return NextResponse.json({ error: 'The laptop server is offline. Switch it on (or check its internet) and try again.' }, { status: 409 });
  }

  const who = session.name || session.email;
  const now = new Date();
  // Emergency: the laptop can't hand over (it's off or unreachable), so the cloud takes over
  // with the last copy. Whatever changed on the laptop since then stays in its backups.
  const data =
    to === 'cloud' && body.emergency
      ? {
          activeServer: 'cloud',
          switchTo: null,
          switchStartedAt: null,
          switchRequestedBy: who,
          note: `Emergency switch to the cloud by ${who}, without a copy from the laptop. Changes made on the laptop after the last copy are kept in its backups.`,
        }
      : { switchTo: to, switchStartedAt: now, switchRequestedBy: who, note: null };

  const res = await controlDb().systemState.updateMany({ where: { id: 'main', updatedAt: s.updatedAt, switchTo: null }, data });
  if (!res.count) return NextResponse.json({ error: 'The server state changed meanwhile; refresh and try again.' }, { status: 409 });

  await audit(session, 'SERVER_SWITCH', { targetType: 'SystemState', targetId: 'main', metadata: { from: s.activeServer, to, emergency: !!body.emergency } });
  return NextResponse.json(view(await currentState()));
});
