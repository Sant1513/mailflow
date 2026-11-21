/**
 * Real-database check (laptop standby only): bounces are ONE list per organisation, unsubscribes stay per workspace,
 * the follow-up/send checks see a teammate's bounce, and the dedupe script removes only true copies.
 * Uses throwaway rows in an existing organisation and removes them again.
 */
import { prisma } from '@/lib/db/client';
import { checkAddresses } from '@/lib/email/addressCheck';
import { suppressedKeys } from '@/lib/email/suppressedKeys';
import { recordHardBounce } from '@/lib/email/bounces';
import { resetOrgScopeCache, visibleToWorkspace } from '@/lib/suppressions/scope';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)}`); };

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const orgs = await prisma.workspace.groupBy({ by: ['organizationId'], _count: { _all: true }, orderBy: { _count: { organizationId: 'desc' } }, take: 1 });
  const orgId = orgs[0]?.organizationId;
  const wss = orgId ? await prisma.workspace.findMany({ where: { organizationId: orgId }, select: { id: true }, take: 3 }) : [];
  if (wss.length < 2) { console.log('SKIP: the standby has no organisation with two workspaces'); process.exit(0); }
  const [w1, w2, w3] = [wss[0]!.id, wss[1]!.id, wss[2]?.id];
  const tag = `qa${Date.now()}`;
  const bounced = `bounced.${tag}@corp-${tag}.com`, unsub = `unsub.${tag}@corp-${tag}.com`, gm = `Dotted.Gm.${tag}@gmail.com`, other = `fine.${tag}@corp-${tag}.com`;
  const mine = (e: string) => e.toLowerCase();
  resetOrgScopeCache();
  try {
    await recordHardBounce({ workspaceId: w1, email: bounced, detail: 'qa: 550 5.1.1 no such user', webhook: false });
    await recordHardBounce({ workspaceId: w1, email: gm, detail: 'qa: no such user', webhook: false });
    await prisma.emailSuppression.create({ data: { workspaceId: w1, email: unsub, reason: 'UNSUBSCRIBED', source: 'UNSUBSCRIBE' } });

    const rows = await prisma.emailSuppression.findMany({ where: { email: { in: [mine(bounced), mine(gm)] } }, select: { workspaceId: true } });
    check('a bounce is saved once (not once per workspace)', rows.length === 2 && rows.every((r) => r.workspaceId === w1), rows);

    const k2 = await suppressedKeys(w2, [bounced, unsub, other, `dottedgm${tag}+x@gmail.com`]);
    check("a teammate's workspace sees the bounce", k2.has(mine(bounced)));
    check('…and it matches a Gmail inbox spelled another way', k2.has(`dottedgm${tag}@gmail.com`));
    check("…but not the other workspace's unsubscribe", !k2.has(mine(unsub)));
    check('…and not an address nobody suppressed', !k2.has(mine(other)));
    const k1 = await suppressedKeys(w1, [unsub]);
    check("the workspace's own unsubscribe still counts for it", k1.has(mine(unsub)));
    const chk = await checkAddresses([bounced, other], w2, { dnsCheck: false });
    check('the send check (checkAddresses) flags the teammate\'s bounce', chk.get(mine(bounced))?.kind === 'SUPPRESSED' && !chk.has(mine(other)), [...chk.entries()]);
    if (w3) check('a third workspace sees it too', (await suppressedKeys(w3, [bounced])).has(mine(bounced)));

    await recordHardBounce({ workspaceId: w2, email: bounced, detail: 'qa: again', webhook: false });
    const again = await prisma.emailSuppression.count({ where: { email: mine(bounced) } });
    check('the same address bouncing again on another workspace adds nothing', again === 1, again);

    const vis = await visibleToWorkspace(w2);
    check('the visibility rule spans the organisation', JSON.stringify(vis).includes(w1));

    // Old-style copies, as the catch-up used to write them: the dedupe script removes them and keeps the original.
    await prisma.emailSuppression.createMany({ data: [w2, ...(w3 ? [w3] : [])].map((w) => ({ workspaceId: w, email: mine(bounced), reason: 'BOUNCED', source: 'BOUNCE', detail: "qa (bounced on a teammate's send)" })) });
    const out = execFileSync('npx', ['tsx', '--env-file=.env', 'scripts/dedupe-suppressions.ts'], { encoding: 'utf8', shell: true });
    check('the dedupe report counts the copies', /copies to remove [1-9]/.test(out), out);
    execFileSync('npx', ['tsx', '--env-file=.env', 'scripts/dedupe-suppressions.ts', '--apply'], { encoding: 'utf8', shell: true });
    const left = await prisma.emailSuppression.findMany({ where: { email: mine(bounced) }, select: { workspaceId: true, detail: true } });
    check('after dedupe one entry is left, the original', left.length === 1 && left[0]!.workspaceId === w1 && !/teammate/.test(left[0]!.detail ?? ''), left);
    check('the unsubscribe was not touched', (await prisma.emailSuppression.count({ where: { email: mine(unsub) } })) === 1);
    check('the address is still blocked for every workspace', (await suppressedKeys(w2, [bounced])).has(mine(bounced)));
  } finally {
    await prisma.emailSuppression.deleteMany({ where: { email: { in: [mine(bounced), mine(unsub), mine(gm)] } } });
    await prisma.record.updateMany({ where: { contact: { primaryEmail: { in: [mine(bounced), mine(gm)] } } }, data: {} }).catch(() => undefined);
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
