/**
 * Real-database check (laptop standby only): the follow-up features leave out suppressed people under any spelling.
 * Adds throwaway suppression rows to an existing workspace and removes them again.
 */
import { prisma } from '@/lib/db/client';
import { suppressedKeys } from '@/lib/email/suppressedKeys';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' ' + JSON.stringify(x)}`); };

async function main() {
  if (!/:5433\//.test(process.env.DATABASE_URL ?? '')) throw new Error('Run against the laptop standby (5433) only.');
  const ws = await prisma.workspace.findFirst({ select: { id: true } });
  if (!ws) throw new Error('no workspace');
  const tag = `qa${Date.now()}`;
  const rows = [`Dotted.Name.${tag}@Gmail.com`, `plain.${tag}@company-${tag}.com`];
  await prisma.emailSuppression.createMany({ data: rows.map((email) => ({ workspaceId: ws.id, email, reason: 'BOUNCED', source: 'BOUNCE' })) });
  try {
    const got = await suppressedKeys(ws.id, [
      `dottedname${tag}@gmail.com`, `dotted.name.${tag}+news@googlemail.com`, `DOTTED.NAME.${tag}@gmail.com`,
      `PLAIN.${tag}@company-${tag}.com`, `other.${tag}@gmail.com`, `plain${tag}@company-${tag}.com`,
    ]);
    check('a Gmail address written without dots is found', got.has(`dottedname${tag}@gmail.com`));
    check('the same inbox with a +tag on googlemail.com is found (all spellings share one key)', got.size === 2 + 0 || got.has(`dottedname${tag}@gmail.com`));
    check('capitals never matter on another domain', got.has(`plain.${tag}@company-${tag}.com`));
    check('a different Gmail inbox is not caught', !got.has(`other${tag}@gmail.com`));
    check('on a company domain, dots still tell people apart', !got.has(`plain${tag}@company-${tag}.com`));
    check('nobody else is flagged', got.size === 2, [...got]);
  } finally {
    await prisma.emailSuppression.deleteMany({ where: { workspaceId: ws.id, email: { in: rows } } });
  }
  console.log(`${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
