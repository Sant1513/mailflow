# MailFlow

Internal Masai School communication, automation, and CRM platform. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the system design and
[PHASE_STATUS.md](PHASE_STATUS.md) for exactly what's real today vs. planned.

**Live:** https://mailflow-six-sooty.vercel.app

## Testing

```bash
npm test                              # 31 unit tests (no DB needed)
npx tsx scripts/smoke-test-db.ts      # 19 checks against the real database
BASE_URL=http://localhost:3000 npx tsx scripts/smoke-test-http.ts   # 22 HTTP checks
```

The two `scripts/smoke-test-*.ts` files are integration harnesses, not app
code. They create their own throwaway org/users/workspaces (including a real
NextAuth database session, the same way the adapter creates one after a
Google sign-in, so RBAC is exercised for OPERATOR / VIEWER / SUPER_ADMIN) and
delete everything they created on the way out. `smoke-test-http.ts` works
against localhost or the deployed URL — set `BASE_URL`.

## Local setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, GOOGLE_CLIENT_ID/SECRET, AUTH_SECRET, ENCRYPTION_KEY
npm run db:migrate     # creates the schema (needs a running Postgres)
npm run dev
```

Generate the two required secrets:

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY
```

### Google OAuth (login)

Create an OAuth 2.0 Client ID in Google Cloud Console (Web application),
authorized redirect URI `http://localhost:3000/api/auth/callback/google`.
Put the client id/secret in `.env`. Only `@masaischool.com` accounts (or
whatever you set `ALLOWED_EMAIL_DOMAIN` to) can sign in — see
`lib/auth/options.ts`.

### First run

1. `npm run dev`, sign in with Google.
2. This creates your `Organization`, your personal `Workspace`, and your
   `User` row (role `OPERATOR` by default).
3. To make yourself `SUPER_ADMIN` locally:
   ```bash
   npx tsx prisma/seed.ts --promote you@masaischool.com
   ```
4. Optionally seed a sample dataset: `npm run db:seed`.

### Redis / queue / Gmail / AI

Not required to run Phase 1 (data import + grid + contacts + admin). They
become required starting Phase 3 — see `.env.example` and
`ARCHITECTURE.md` §9-11 for what each variable is for.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run build` / `start` | Production build / run |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm test` | Vitest (unit tests, no DB required) |
| `npm run db:migrate` | Prisma migrate (dev) |
| `npm run db:studio` | Prisma Studio, browse the DB |
| `npm run db:seed` | Seed org + sample dataset |

## What's real vs. not yet

This codebase follows one rule strictly (§140 of the spec): **no fake
functionality**. Anything not yet wired to a real database/API is marked
plainly in the UI ("Not yet implemented — planned in Phase N") rather than
faked. See [PHASE_STATUS.md](PHASE_STATUS.md) for the authoritative list.
