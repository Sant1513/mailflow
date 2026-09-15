# MailFlow

Internal Masai School communication, automation, and CRM platform. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the system design and
[PHASE_STATUS.md](PHASE_STATUS.md) for exactly what's real today vs. planned.

**Live:** https://mailflow-six-sooty.vercel.app

## Testing

```bash
npm test                              # unit tests (no DB needed)
npx tsx scripts/smoke-test-db.ts      # checks against the real database
BASE_URL=http://localhost:3000 npx tsx scripts/smoke-test-http.ts   # authenticated HTTP checks
BASE_URL=https://<deployed-url> npx tsx scripts/verify-deployment.ts  # RUN AFTER EVERY DEPLOY
```

`npm run verify` runs typecheck + lint + unit tests + **a real production
build** in one go. The build step is not optional: `tsc --noEmit` does not
catch Next.js's own route-file constraints (a route may only export HTTP
handlers), so a change can typecheck cleanly and still fail to deploy.

**Always run `verify-deployment.ts` after deploying.** It hits the real URL
as an anonymous visitor and asserts nothing 5xxs. It exists because a
production outage (NextAuth missing its secret) slipped past every other
suite — the authenticated suite signs in first, so it never exercised the
signed-out path a real first-time visitor takes.

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
openssl rand -base64 32   # NEXTAUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY
```

`NEXTAUTH_SECRET` is **required in production** — NextAuth refuses to start
without it. It is optional in development, which is exactly why a missing
one is easy to ship: set it in your deployment environment, not just
locally. `NEXTAUTH_URL` must match the deployed origin exactly.

### Deployment environment

Set env vars at the **project level** (`vercel env add NAME production`), not
via per-deploy `-e` flags — flags are easy to forget on a later deploy, and
forgetting `NEXTAUTH_SECRET` takes the whole site down.

### Google OAuth (login)

Create an OAuth 2.0 Client ID in Google Cloud Console (Web application) and
add **all** of these as Authorized redirect URIs:

```
http://localhost:3000/api/auth/callback/google
http://localhost:3000/api/gmail/callback
https://<your-deployment>/api/auth/callback/google
https://<your-deployment>/api/gmail/callback
```

Login and Gmail-connect are separate OAuth flows with separate callbacks, so
both are required — and the URIs are origin-specific, which is why local dev
is pinned to port 3000 (`.claude/launch.json`, `autoPort: false`).

Put the client id/secret in `.env`.

### Who can sign up

`ALLOWED_EMAIL_DOMAIN` controls this:

| Value | Effect |
| --- | --- |
| unset / empty | **Open signup** — any Google account can create a workspace |
| `masaischool.com` | Only `@masaischool.com` accounts can sign in |

It is currently **open**. Note what that means operationally: anyone who
finds the URL can sign up, connect their own Gmail, and send from it. Set
`ALLOWED_EMAIL_DOMAIN` before loading real student data. Disabled accounts
are rejected in either mode. See `isEmailAllowed()` in `lib/auth/options.ts`.

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

## Features

### Inbox & conversations
- Threaded email inbox with collapsible message bodies
- Smart reply composer with quoted email trail included in outgoing replies
- CC/BCC support with full reply chain preserved
- Conversation assignment, tagging, and status (open / snoozed / resolved)
- Follow-up due tracking
- Sync Gmail replies sent outside the tool back into the thread

### Dashboard
- Real-time metrics: emails sent, reply rate, failed, pending, unread, open conversations, resolution rate, follow-ups due
- **FRT (First Response Time)** and **ART (Average Response Time)** across all conversations
- 7 / 30 / 90 day date filter
- Campaign performance table with open/click rates
- Per-user FRT/ART breakdown for super admins (Admin → Users → Response Times section)

### Email campaigns
- Dataset-backed bulk campaigns with Gemini AI personalisation
- Approval-gated sending: campaigns need admin sign-off before dispatch
- Campaign approval page with audit trail, requester/reviewer email thread, and inline expand/collapse

### Notifications
- Bell icon in sidebar header with live unread count
- 2-second auto-popup toast when a new notification arrives, with "View" deep-link
- Groups by Today / Yesterday / older; mark-all-read and per-item read

### User registration approval
- New sign-ups start as **PENDING** and cannot access the app until approved
- Pending users see an approval-waiting screen with a pre-filled mailto link to the admin
- Super admins see a **User Registrations** section under Approvals, with approve / reject (disable) actions
- Bell notification fires to all super admins on every new registration
- First-ever registrant is auto-promoted to SUPER_ADMIN (bootstrap)

### Admin
- User management: roles, activation/deactivation
- View-as: super admins can inspect any workspace without logging out
- Per-user response-time metrics (FRT/ART) with date filter

### Optional env vars
| Variable | Effect |
| --- | --- |
| `ALLOWED_EMAIL_DOMAIN` | Restrict sign-up to one domain (e.g. `masaischool.com`) |
| `ADMIN_CONTACT_EMAIL` | Email shown on the pending-approval screen (fallback: `admin@masaischool.com`) |

## What's real vs. not yet

This codebase follows one rule strictly (§140 of the spec): **no fake
functionality**. Anything not yet wired to a real database/API is marked
plainly in the UI ("Not yet implemented — planned in Phase N") rather than
faked. See [PHASE_STATUS.md](PHASE_STATUS.md) for the authoritative list.
