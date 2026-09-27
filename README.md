# MailFlow

Masai School's internal platform for talking to students and getting paperwork signed. One sign-in, two products:

| Product | What it's for |
| --- | --- |
| **MailFlow Mail** | Personalised email campaigns from your own Gmail, a shared inbox for replies, contacts and data, automations, dashboards |
| **MailFlow Sign** | Send agreements for e-signature: one at a time or in bulk from a CSV, with multiple signers, placed signatures and tracked reminders |

- **Live:** https://mailflow-six-sooty.vercel.app
- **Repo:** https://github.com/Sant1513/mailflow
- **Status (27 Sep 2026):** Phases 1–7 shipped, Sign shipped (S1–S6), Mail/Sign product split shipped. 509 unit tests passing. See [Phase status](#phase-status).

Deeper docs: [ARCHITECTURE.md](ARCHITECTURE.md) (system design) · [PHASE_STATUS.md](PHASE_STATUS.md) (detailed phase log up to 10 Sep) · [USER_GUIDE.md](USER_GUIDE.md) (team guide).

## Contents

- [Two products, one sign-in](#two-products-one-sign-in)
- [MailFlow Mail](#mailflow-mail)
- [MailFlow Sign](#mailflow-sign)
- [Shared platform](#shared-platform)
- [Phase status](#phase-status)
- [Release history](#release-history)
- [Known gaps](#known-gaps)
- [Tech stack](#tech-stack)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Scheduled jobs](#scheduled-jobs)
- [Testing](#testing)
- [Deployment](#deployment)
- [Scripts](#scripts)

## Two products, one sign-in

- **Choose after signing in.** Everyone lands on a chooser ("where do you want to go?") with a Mail card and a Sign card. **Remember my choice** skips it next time (saved per browser). Change it later via **Choose start product** at the bottom of the sidebar.
- **Separate sidebars.** Each product shows only its own pages. Settings, Approvals and Super Admin are shared and keep the sidebar of the product you came from.
- **Switch any time.** The **Mail | Sign** toggle at the top of the sidebar (and in the phone top bar) switches in one click and returns you to the last page you used in the other product. Keyboard: `g m` for Mail, `g e` for Sign.
- **Old links keep working.** Every existing URL opens in the right product. Route ownership lives in one place: [`lib/products.ts`](lib/products.ts).

## MailFlow Mail

### Inbox and conversations
- One inbox for every reply to MailFlow email, synced from Gmail (history API with a scan fallback; triaged so a ~900-message backlog drains in about a minute).
- Only MailFlow threads and direct replies to MailFlow mail are ingested; the rest of the mailbox is left alone.
- Header-first classification of bounces, out-of-office and auto-replies; only a real human reply counts as "the student replied".
- Replies from the app stay in the same Gmail thread (correct `In-Reply-To` / `References`), include the quoted trail, and support attachments (4 MB per reply), a saved signature, snippets with `{{variables}}`, drafts that autosave, and **scheduled replies**.
- Replies typed straight in Gmail also appear in the thread.
- Assignment, tags, status (open / waiting / resolved), follow-ups, internal notes, **bulk actions**, **merge conversations**, and export of a thread.
- Filters for unread, mine, open, waiting, resolved, assignee and tag, plus search across names, addresses, subjects and message text.
- **SLA rules**: first-response and resolution targets per workspace, by tag or assignee; overdue conversations get a red badge.
- Attach a student's signed documents to a reply in one click ("Current Document"), or upload files ("Old Document").
- **AI triage** of every human reply (switchable per organisation in Admin → System settings → Automation):
  - tags the conversation by intent (Question, Request, Complaint, Needs action, Completed, Thanks);
  - assigns unassigned conversations (an assignee per intent, or the mailbox owner), with the usual notification;
  - closes plain "thank you" replies when the AI is at least 85% sure and the team has already replied, leaving an internal note;
  - drafts an answer to questions and requests. The conversation shows **AI draft ready** with **Approve & send**, **Edit** and **Discard**, and the inbox shows a badge.

### Campaigns
- Dataset-backed campaigns sent from the operator's own Gmail, with From name, Reply-To, CC and BCC. The sending address is always the connected mailbox.
- **Pre-send review** and a **dry run** that use the same evaluator as the real send, so "who gets what and why" is known before anything goes out.
- **Approval gate**: campaigns need an admin's sign-off, with request and decision emails in one thread and a full audit trail.
- **Scheduling** with a date-time picker, or send now.
- **Batches** with live progress, pause / resume / cancel, retry of failed sends (permanent failures are never retried), and duplicate protection enforced by a database constraint.
- **Personalised PDFs**: attach a per-recipient filled PDF to every email, built in the **PDF Library**.
- Draft campaigns can swap dataset or template and re-sync to the latest template version.

### Tracking and deliverability
- Open pixel and click tracking on every campaign email. Links are signed together with their destination, so they can only redirect to the link that was in the email.
- Every link opens however it was written: pasted URLs become links, and addresses typed without `https://` (for example `levelupcareer.in`) are fixed.
- One-click **unsubscribe** on every campaign email, and a **suppression list** that blocks sends. Hard bounces are suppressed automatically, with an audit trail.
- **Campaign analytics**: Overview / Sent / Read / Clicked / Replied / Failed tabs, KPI tiles, a per-day trend chart and per-tab email lists.

### Templates, data and contacts
- HTML/CSS template editor (CodeMirror) with a live preview, rendered with a real dataset record or contact.
- Every save is an immutable version, and campaigns pin the version they were created with.
- **Email health check** before sending: subject, variables, links, images, the plain-text part, and Gmail's ~102 KB clipping limit.
- XSS-safe preview (escaped values, sanitised HTML, sandboxed iframe).
- Airtable-style **Data** grid: import from paste, CSV or XLSX (with duplicate handling), inline edit, typed columns, saved views, filter / sort / group / search on the server, bulk edit and change history.
- **Contacts** resolved from data automatically, contact **segments**, deduplication on import, and a per-contact timeline.
- **Google Sheets two-way sync** per dataset ("Google Sheet" on the dataset toolbar). Rows are matched by a key column such as email and sync every 15 minutes or on **Sync now**:
  - sheet edits come into MailFlow, and new sheet rows become records;
  - cells edited in MailFlow since the last sync, and rows added in MailFlow, go to the sheet;
  - signing columns always go from MailFlow to the sheet;
  - nothing is deleted on either side, and the first sync imports rows without running automations.
  It uses an extra Google permission (Sheets) added to the existing Gmail connection.

### Automations
- Trigger → conditions (AND/OR, 8 operators) → actions (send email, update record, notify a user).
- Stop conditions such as "already replied", frequency caps and cooldowns, versioning (editing turns the automation off until it's re-confirmed), a safety gate that shows the affected-record count before enabling, and a full run log.
- **WAIT** steps (need Redis; see [Known gaps](#known-gaps)).
- **Signing presets**: "when the document is signed" and "when not signed after N days", based on the signing columns written to each row.

### Dashboards and AI
- **Dashboard**: sent, reply rate, failed, pending, unread, open conversations, resolution rate, follow-ups due, open and click rates, **first response time (FRT)** and **average response time (ART)**, over a 7 / 30 / 90 day window.
- **Performance**: per-agent volume, FRT / ART and resolution rate, with a trend chart. **Reports**: signing and campaign KPIs with CSV export.
- **Daily "needs attention" digest** by email and Slack (09:00 IST): unanswered replies older than 24 hours, SLA breaches, unsigned documents near expiry, and campaigns and users waiting for approval. Skipped on days with nothing to report.
- **Weekly report** to super admins every Monday (email, optional Slack): campaigns, opens, clicks, replies, documents sent and signed, median time to sign, FRT / ART and top responders, compared with the week before.
- Both are set up in **Admin → System settings → Automation** (sender mailbox, recipients, thresholds), with a preview and a test send.
- **Gemini AI assistant**: write or improve templates, subject ideas, suggested replies, conversation summaries with a suggested next step, reply intent, and "Why was this sent?". Per-user and per-org daily limits. The AI never sends anything or changes data on its own.

## MailFlow Sign

### Sending
- **New Request**: send one document to one person, with CC, an expiry, a custom email subject/body and extra attachments (PDF, Word, images).
- **Signing templates**: reusable documents with `{{variables}}`, a saved **signer setup** and saved **signature positions**.
  - **Import from Word or Google Docs**: upload a `.docx` or paste a Google Doc link (shared "Anyone with the link"). `{{fields}}` are detected automatically, even when Word splits them across formatting.
  - **Keeps the exact formatting**: fonts, sizes, colours, highlights, spacing, line spacing, alignment, indents, tab stops, numbered and bulleted lists, tables (widths, borders, shading, merged cells), images, text boxes and the page header / footer are converted to inline CSS. Word fonts load as metric-compatible web fonts (Calibri → Carlito, Arial → Arimo, Times New Roman → Tinos) so lines wrap where they did in Word, and the signed PDF uses the document's own page size and margins, so pages break in the same places.
- **Send for signature from Data**: select rows in a dataset, or use a contact segment. Columns are matched to template fields and to the signer's name and email automatically, and you can change any match.
- **Bulk Send from a CSV**, one document per row:
  - Values present in the CSV are **locked** for the signer.
  - **Blank cells and missing columns are filled in by the signer** before they can sign.
  - Headers match loosely (`Signer 1 Name` = `signer_1_name`), and there's a sample CSV download and a per-row **Preview** with the real PDF.
- **Up to 3 signers per document**, signing **sequentially** (1 → 2 → 3) or **in parallel**.
  - Assign which blank fields each signer fills.
  - Signers 2–3 can be the **same person on every row** (for example the Masai signatory), with no CSV columns needed.

### Signature placement
- **Drag-and-drop editor** on the real document pages: drop a box per signer, drag to move, pull the corner to resize.
- Boxes are **anchored to the paragraph or table cell they sit in**, so they stay in place when real names and addresses make the text longer or shorter.
- Positions can be saved on the template or adjusted per batch, and sent documents keep their own copy.

### Signing experience
- Public, mobile-friendly signing page: draw or type the signature, fill any required fields, and preview the exact PDF with "you sign here" boxes.
- Fields filled by an earlier signer are locked for later signers.
- Signatures are saved transparent and trimmed to the ink, so they sit cleanly on table lines.

### PDFs
- Signed PDFs are **printed with headless Chrome from the same HTML the signer reviewed**. Headings, justified text, tables and the app's font all match the signing page.
- The built-in pdf-lib renderer takes over, with a logged error, if Chrome is ever unavailable.
- Every signed copy ends with a **certificate of completion** (signers, timestamps, IPs, field values). Multi-signer documents also produce a **combined PDF** with every signature, emailed to all signers.

### After sending
- **Documents** list: **one row per document**, with each signer's status (sent, viewed, signed, waiting for their turn) and "IN PROGRESS 1/3".
- **Preview / Edit before anyone signs**: correct values or the recipient and re-notify on the same link. Locked as soon as anyone signs.
- **Void** cancels the whole document for everyone who hasn't signed. **Resend** reminds whoever's turn it is. **Re-request** issues a fresh link (single-signer documents).
- **Automatic reminders** (up to 3, two days apart, with an urgency note near expiry), plus a **Sign analytics** dashboard, bulk batch pages and signed-PDF downloads.
- **Status written back to the data row** for documents sent from Data: Signing status, Sent for signature, Signed at, Days waiting to sign, and a Signed document link. These update when a document is viewed, signed, voided or expires, and daily.

## Shared platform

- **Accounts**: Google sign-in; new users are **pending until a super admin approves** them (the first user becomes super admin). Sign-up can be locked to one domain.
- **Roles**: SUPER_ADMIN / ADMIN / OPERATOR / VIEWER, enforced on the server for every page and API route.
- **Approvals**: campaign approvals and user registrations in one place, with a pending badge.
- **Notifications**: in-app bell with pop-up toasts; Slack and email for assignments, resolutions and follow-ups (same Slack thread and email thread).
- **Super Admin**: organisation analytics, users, workspaces, all data and conversations, **view workspace as** (read-only, audited), audit logs with filters, retention policy settings, and Slack integration.
- **Settings**: Gmail connection, email signature, snippets, SLA rules, **outbound webhooks** (HMAC-SHA256 signed; for conversation, bounce and unsubscribe events), and your Slack member ID.
- Light / dark / system theme, responsive layout, installable PWA, keyboard shortcuts (`?` for help).

## Phase status

"Done" means a real database-backed API, a UI that calls it, server-side authorisation and, where practical, tests. Nothing is marked done on UI alone.

| Phase | Scope | Status | Shipped |
| --- | --- | --- | --- |
| 1 · Foundation | Google login, orgs/workspaces/RBAC, data grid, import, contacts, audit log | ✅ Done (grid virtualisation open) | 5–7 Sep |
| 2 · Templates | Versioned editor, variables, personalised preview, health check | ✅ Done (visual drag-and-drop builder open) | 5 Sep |
| 3 · Gmail + campaigns | Gmail OAuth, MIME/threading, review, dry run, approvals, batches, queue, scheduling | ✅ Done | 5–16 Sep |
| 4 · Automations | Conditions, stop rules, frequency, versioning, safety gate, WAIT | ✅ Done (WAIT and scheduled triggers need Redis) | 5–15 Sep |
| 5 · Inbox | Gmail sync, classification, conversations, replies | ✅ Done (Gmail push renewal open) | 5–10 Sep |
| 6 · Super Admin | Org analytics, view-as, retention policy | ✅ Done (retention enforcement deferred by design) | 6 Sep |
| 7 · Gemini AI | Provider abstraction, limits, assistants, intent | ✅ Done | 6 Sep |
| Feedback rounds 1–2 | Approvals page, themes, responsive UI, composer, Slack, notifications, auto-sync | ✅ Done | 7–10 Sep |
| Mail round 3 | Tracking, unsubscribe, suppressions, engagement analytics, scheduling, PWA, segments, SLA, webhooks, merge, bulk inbox, performance, campaign analytics, registration approval, personalised PDFs | ✅ Done | 15–17 Sep |
| S1 · Sign basics | Signing requests, public signing page, signed PDF, certificate, templates, bulk send, reminders, analytics, attachments | ✅ Done | 17 Sep |
| S2 · Multi-signer | Sequential/parallel groups, field assignment, presets, combined PDF, batch void | ✅ Done | 23 Sep |
| S3 · Signer-filled fields + editing | Blank CSV fields for signers, previews, edit before signing | ✅ Done | 23 Sep |
| S4 · Signature placement | Drag-and-drop boxes, anchored to text | ✅ Done | 23–24 Sep |
| S5 · Faithful PDFs | Headless-Chrome printing that matches the signing page | ✅ Done | 24 Sep |
| S6 · Signer setup + documents list | Fixed signers, free-text setup, one row per document, whole-document void/resend | ✅ Done | 24 Sep |
| Mail fixes | Live-site tracking links, signed redirects, link normalisation | ✅ Done | 24 Sep |
| Product split | Mail / Sign chooser, separate sidebars, switcher | ✅ Done | 25 Sep |
| Automation pack | Daily digest, weekly report, send for signature from Data, signing write-back and presets, Google Sheets two-way sync, AI inbox triage, Word / Google Doc template import | ✅ Done | 27 Sep |
| 8 · Advanced analytics / integrations | Webhooks, SLA, performance, campaign analytics shipped; virtualisation and Gmail push renewal open | 🟡 In progress | — |

## Release history

Most recent first. Full detail is in `git log`.

| Date | Release |
| --- | --- |
| 27 Sep | **Automation pack**: daily digest and weekly report, send for signature from Data, signing status written back to rows with automation presets, Google Sheets two-way sync, AI inbox triage with one-click drafts, and Word / Google Doc template import (`f0dd831`) |
| 25 Sep | **Mail and Sign become two products** with a chooser after sign-in, separate sidebars and a one-click switcher (`f2ab486`) |
| 24 Sep | **Email links fixed**: tracking used `localhost:3000` in production; links now use the live site, click redirects are signed, and scheme-less or pasted links open correctly (`c1befc3`) |
| 24 Sep | **Signature boxes follow their text**; transparent, trimmed signatures; fixed-person signers; one row per document; whole-document Void/Resend; signed-PDF attachment in replies restored (`c7454de`) |
| 24 Sep | **Signing PDFs printed with headless Chrome** so they match the signing page (`63b2109`) |
| 23 Sep | **Drag-and-drop signature placement** and a per-row document preview (`e596b8d`) |
| 23 Sep | **Signer-fillable blank CSV fields**, PDF previews, edit before signing, locked-field signing fix (`9a475b8`) |
| 23 Sep | **Multi-signer** improvements: parallel completion, presets, combined PDF, batch void; builds now apply database migrations automatically (`d64ba72`, `f3ae468`) |
| 17 Sep | **E-signature launched**: signing requests, templates, bulk send, reminders, analytics, attachments, reports (`0797f5b` … `bb5d96d`) |
| 17 Sep | SLA rules, outbound webhooks, merge conversations, campaign analytics, audit-log filters, bulk inbox, performance dashboard, segments, bounce auto-suppress (`3897b54` … `3a4db46`) |
| 15–16 Sep | Tracking, unsubscribe, suppressions, engagement analytics, WAIT step, campaign scheduling, PWA, registration approval, personalised PDFs (`35f8fdf` … `e2373b5`) |
| 5–10 Sep | Phases 1–7 and feedback rounds 1–2 (see [PHASE_STATUS.md](PHASE_STATUS.md)) |

## Known gaps

Being explicit about what is *not* live yet:

- **No Redis in production.** Automation **WAIT** steps are skipped, and **scheduled campaigns and scheduled replies** are dispatched by the daily cron at 00:00 UTC (05:30 IST), not at the exact chosen time. Adding a Redis (for example Upstash's free tier) as `REDIS_URL` makes both run on time.
- **Attachments on signing requests** upload to Vercel Blob, which needs `BLOB_READ_WRITE_TOKEN`. It isn't set in production, so those uploads are expected to fail. Connecting a Blob store to the Vercel project fixes this.
- **Vercel Hobby crons run once a day.** Gmail sync and follow-up reminders run every 15 minutes via GitHub Actions; the other jobs run daily (see [Scheduled jobs](#scheduled-jobs)).
- Not built yet: data-grid virtualisation beyond 5,000 rows, Gmail push (`users.watch`) renewal, attachment byte download for inbound mail, retention enforcement (deliberately deferred), workspace create/rename/disable actions, a visual template builder, and a per-org AI switch.
- The start-product choice is saved per browser, so each new device shows the chooser once.
- **Google Sheets sync** needs the Google Sheets API enabled in the Google Cloud project and the `spreadsheets` scope on the OAuth consent screen. Unless the consent screen is Internal, Google shows an "unverified app" warning for that scope. Sync handles up to 5,000 rows per sheet; if two people edit the same cell in both places between syncs, the MailFlow edit wins.
- Google Doc import only works for docs shared "Anyone with the link can view" (otherwise download as .docx and upload). Imported documents show the header once at the top rather than on every page, floating objects are placed approximately, and EMF/WMF images (old Word charts) are left out with a warning.

## Tech stack

| Layer | Choice |
| --- | --- |
| App | Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS |
| Auth | NextAuth (Google OAuth, database sessions) |
| Database | PostgreSQL on Neon, Prisma ORM with versioned migrations |
| Email | Gmail API from each user's own mailbox (OAuth tokens AES-256-GCM encrypted at rest) |
| Queue | BullMQ + Redis when available, otherwise bounded drain endpoints and crons |
| PDFs | Headless Chromium (`puppeteer-core` + `@sparticuz/chromium`) for signing PDFs, `pdf-lib` for overlays, certificates and personalised campaign PDFs, `pdfjs-dist` for page previews |
| Files | Vercel Blob (signing attachments) |
| AI | Google Gemini via a provider abstraction |
| Hosting | Vercel (Hobby), GitHub Actions for 15-minute schedules |

## Local setup

```bash
npm install
cp .env.example .env    # fill in the values below
npm run dev             # http://localhost:3000 (pinned: the OAuth redirect URIs are port-specific)
```

> ⚠️ **Check which database `.env` points at before running any Prisma command.** If `DATABASE_URL` is the production Neon database, `npm run db:migrate` (`prisma migrate dev`) would change production. New migrations should be written as SQL files in `prisma/migrations/` and are applied by the production build (`prisma migrate deploy`).

Generate the two required secrets:

```bash
openssl rand -base64 32   # NEXTAUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY
```

**Google OAuth.** Create a Web OAuth client and add all four redirect URIs. Sign-in and Gmail-connect are separate flows:

```
http://localhost:3000/api/auth/callback/google
http://localhost:3000/api/gmail/callback
https://<your-deployment>/api/auth/callback/google
https://<your-deployment>/api/gmail/callback
```

**First run.** Sign in with Google. The first user becomes SUPER_ADMIN; later users wait for approval. To promote someone manually: `npx tsx prisma/seed.ts --promote you@masaischool.com`. To seed a sample dataset: `npm run db:seed`.

**Signing PDFs locally** use an installed Chrome or Edge (auto-detected, or set `CHROME_PATH`).

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` / `DIRECT_URL` | ✅ | Postgres (pooled) and a direct connection for migrations |
| `NEXTAUTH_SECRET` | ✅ prod | Session signing. NextAuth refuses to start in production without it |
| `NEXTAUTH_URL` | ✅ prod | Exact public origin. Also the base for every link in emails (signing, tracking, unsubscribe) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✅ | Google sign-in and Gmail connect |
| `ENCRYPTION_KEY` | ✅ | Encrypts Gmail tokens and signs tracking/unsubscribe links |
| `CRON_SECRET` | ✅ prod | Authorises the `/api/cron/*` jobs |
| `ALLOWED_EMAIL_DOMAIN` | — | Lock sign-up to one domain (unset = open sign-up, still gated by approval) |
| `ADMIN_CONTACT_EMAIL` | — | Shown to users waiting for approval |
| `REDIS_URL` | — | Enables the BullMQ queue, exact-time scheduling and automation WAIT steps |
| `BLOB_READ_WRITE_TOKEN` | — | Vercel Blob, for attachments on signing requests |
| `SLACK_BOT_TOKEN` | — | Slack notifications (channel set in System Settings) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — | AI assistant (the app runs without it) |
| `AI_ENABLED`, `AI_USER_DAILY_LIMIT`, `AI_ORG_DAILY_LIMIT` | — | AI switch and daily limits (defaults 100 per user, 1000 per org) |
| `EMAIL_RATE_LIMIT_PER_MINUTE`, `EMAIL_MAX_ATTEMPTS` | — | Send pacing and retry limit |
| `GMAIL_PUBSUB_TOPIC` / `GMAIL_PUBSUB_VERIFICATION_TOKEN` | — | Gmail push notifications (Sync Now and auto-sync work without them) |
| `CHROME_PATH` | — | Local Chrome/Edge for signing PDFs (auto-detected on Windows, macOS and Linux) |
| `SIGNING_PDF_RENDERER` | — | `pdf-lib` forces the built-in renderer; `browser` forces Chrome |

Set production variables at the project level (`vercel env add NAME production`), not per deploy.

## Scheduled jobs

| Job | Vercel cron (UTC) | GitHub Actions |
| --- | --- | --- |
| `/api/cron/gmail-sync`: sync every connected mailbox | 03:00 daily | every 15 min |
| `/api/cron/follow-ups`: follow-up reminders (app + Slack) | 03:30 daily | every 15 min |
| `/api/cron/scheduled-send`: dispatch scheduled campaigns | 00:00 daily | — |
| `/api/cron/scheduled-replies`: send scheduled replies | 00:00 daily | — |
| `/api/cron/sla-check`: flag SLA breaches | 08:00 daily | — |
| `/api/cron/signing-reminders`: remind unsigned signers, expire overdue links, refresh "Days waiting to sign" on rows | 09:00 daily | — |
| `/api/cron/daily-digest`: "needs attention" digest (email + Slack) | 03:30 daily (09:00 IST) | — |
| `/api/cron/weekly-report`: weekly report to leadership | 03:30 Mondays | — |
| `/api/cron/sheets-sync`: two-way Google Sheets sync | 03:15 daily | every 15 min |

## Testing

```bash
npm test                 # 585 unit tests across 48 files (no database needed)
npm run verify           # typecheck + lint + unit tests + a real production build (into .next-verify)
BASE_URL=https://<deployed-url> npx tsx scripts/verify-deployment.ts   # run after every deploy
```

`npm run verify` includes a real build on purpose: `tsc` doesn't catch Next.js route-file rules, so a change can typecheck and still fail to deploy.

**Integration harnesses** (`scripts/smoke-test-*.ts`) create their own throwaway organisation, users, sessions and data, exercise the real APIs and pages, then delete everything they created. Point them at localhost or production with `BASE_URL`. They never sign in as a real account.

| Script | Covers |
| --- | --- |
| `smoke-test-automation-pack-http.ts` | Send for signature from Data and segments, signing write-back, Word import, AI drafts and triage, Sheets connect flow, settings access (41 checks) |
| `smoke-test-products-http.ts` | Mail/Sign chooser, remembered choice, sidebars for every route type (19 checks) |
| `smoke-test-http.ts` | Core HTTP + RBAC for OPERATOR / VIEWER / SUPER_ADMIN |
| `smoke-test-send.ts` · `smoke-test-automation.ts` | Send pipeline and automation engine against the live database |
| `smoke-test-inbox.ts` · `smoke-test-inbox-http.ts` · `smoke-test-inbox-notify-http.ts` | Gmail ingestion, conversations, composer, notifications |
| `smoke-test-approvals-http.ts` · `smoke-test-admin-http.ts` · `smoke-test-grid-http.ts` · `smoke-test-pages-http.ts` | Approvals, super admin, data grid, page sweep |
| `smoke-test-documents.ts` · `smoke-test-ai.ts` · `smoke-test-db.ts` | Personalised PDFs, Gemini, database checks |

## Deployment

- Every push to `master` deploys to production on Vercel.
- The build runs `prisma migrate deploy && prisma generate && next build`, so **pending migrations are applied to the production database on deploy**. Review migration SQL before pushing.
- Vercel builds with Node 24. Signing-PDF routes bundle the Chromium binary (`next.config.mjs` → `outputFileTracingIncludes`) and allow up to 60 s for a cold start.
- After deploying, run `scripts/verify-deployment.ts`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run build` / `start` | Production build (with migrations) / run |
| `npm run verify` | Typecheck + lint + tests + isolated build |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm test` | Vitest unit tests |
| `npm run db:migrate:deploy` | Apply pending migrations |
| `npm run db:studio` | Browse the database |
| `npm run db:seed` | Seed an org and a sample dataset |
| `npm run worker:email` · `worker:gmail-sync` · `worker:automation` | Queue workers (need Redis) |
