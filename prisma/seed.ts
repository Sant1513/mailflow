import { PrismaClient, ColumnType, Role } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Mirrors allowedDomain() in lib/auth/options.ts. Note the trim/empty check:
 * "?? 'masaischool.com'" was wrong, because ?? only falls back on
 * null/undefined and open signup sets ALLOWED_EMAIL_DOMAIN="". That keyed an
 * organization on the empty string and silently created a SECOND org.
 */
function allowedDomain(): string | null {
  const configured = process.env.ALLOWED_EMAIL_DOMAIN?.trim();
  return configured ? configured.toLowerCase() : null;
}

/** Same resolution rule as auth: with open signup, reuse the existing org. */
async function resolveOrganization() {
  const restriction = allowedDomain();
  if (restriction) {
    return prisma.organization.upsert({
      where: { allowedDomain: restriction },
      update: {},
      create: { name: 'Masai School', allowedDomain: restriction },
    });
  }
  const existing = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) return existing;
  return prisma.organization.create({ data: { name: 'MailFlow', allowedDomain: '*' } });
}

/**
 * Seeds the Organization and a sample dataset (§122). Does NOT create fake
 * users — real users are created on first Google sign-in (see
 * lib/auth/options.ts). To make yourself SUPER_ADMIN locally, sign in once
 * then run: npx tsx prisma/seed.ts --promote you@masaischool.com
 */
async function main() {
  const org = await resolveOrganization();
  console.log(`Organization ready: ${org.name} (${org.id})`);

  const promoteFlagIdx = process.argv.indexOf('--promote');
  if (promoteFlagIdx !== -1) {
    const email = process.argv[promoteFlagIdx + 1];
    if (!email) throw new Error('Usage: --promote <email>');
    const user = await prisma.user.update({
      where: { email },
      data: { role: Role.SUPER_ADMIN },
    });
    console.log(`Promoted ${user.email} to SUPER_ADMIN.`);
    return;
  }

  // Sample dataset for anyone who already has a workspace, so there's
  // something to look at (§122/§123).
  const anyUser = await prisma.user.findFirst({
    where: { organizationId: org.id },
    include: { ownedWorkspaces: true },
  });
  if (!anyUser || !anyUser.ownedWorkspaces[0]) {
    console.log('No signed-in user yet — sign in once via Google, then re-run the seed.');
    return;
  }
  const workspace = anyUser.ownedWorkspaces[0];

  const existing = await prisma.dataset.findFirst({
    where: { workspaceId: workspace.id, name: 'Sample: Placement Students' },
  });
  if (existing) {
    console.log('Sample dataset already exists, skipping.');
    return;
  }

  const dataset = await prisma.dataset.create({
    data: {
      organizationId: org.id,
      workspaceId: workspace.id,
      ownerId: anyUser.id,
      name: 'Sample: Placement Students',
      description: 'Seeded sample dataset (§122)',
      columns: {
        create: [
          { key: 'Name', label: 'Name', type: ColumnType.TEXT, order: 1 },
          { key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 2 },
          { key: 'Code', label: 'Code', type: ColumnType.TEXT, order: 3 },
          { key: 'Deadline', label: 'Deadline', type: ColumnType.TEXT, order: 4 },
          { key: 'Status', label: 'Status', type: ColumnType.STATUS, order: 5 },
          { key: 'Trigger', label: 'Trigger', type: ColumnType.CHECKBOX, order: 6 },
        ],
      },
      records: {
        create: [
          {
            data: {
              Name: 'Rahul Sharma',
              Email: 'rahul@example.com',
              Code: 'fd41_470074',
              Deadline: '16 April 2025',
              Status: 'Pending',
              Trigger: true,
            },
          },
          {
            data: {
              Name: 'Priya Sharma',
              Email: 'priya@example.com',
              Code: 'fd39_246',
              Deadline: '16 April 2025',
              Status: 'Pending',
              Trigger: true,
            },
          },
        ],
      },
    },
  });
  console.log(`Sample dataset created: ${dataset.name}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
