# MailFlow — Architecture

Internal Masai School communication / automation / CRM platform. This document
is the system design referenced by the implementation. It is written before
code, and kept in sync as the code evolves.

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            Next.js App (Vercel/Node)                 │
│  ┌───────────────┐   ┌──────────────┐   ┌────────────────────────┐  │
│  │  App Router UI │   │  API Routes  │   │  Server Actions (edit) │  │
│  │  (RSC + client)│   │  (REST-ish)  │   │                        │  │
│  └───────┬───────┘   └──────┬───────┘   └───────────┬────────────┘  │
│          │                  │                        │              │
│          └────────────┬─────┴────────────────────────┘              │
│                        │  lib/* (auth, permissions, db, gmail, ai)   │
└────────────────────────┼──────────────────────────────────────────┘
                          │
      ┌───────────────────┼────────────────────┐
      │                   │                    │
┌─────▼─────┐      ┌──────▼──────┐      ┌──────▼──────┐
│ PostgreSQL │      │ Redis+BullMQ │      │  Gmail API   │
│ (Prisma)   │      │ queues       │      │  Gemini API  │
└────────────┘      └──────┬───────┘      └──────────────┘
                            │
                 ┌──────────┴──────────┐
                 │  Worker process(es)  │
                 │  email-worker        │
                 │  gmail-sync-worker   │
                 │  automation-worker   │
                 └──────────────────────┘
```

- **Web app**: Next.js (App Router, TS, Tailwind, shadcn/ui). Server Components
  for read views, API routes for all mutating/queued operations so the same
  endpoints can be called by workers, tests, and the UI.
- **Workers**: separate Node processes (same repo, `/workers`) consuming
  BullMQ queues. Never send bulk email inline in an HTTP request.
- **DB**: PostgreSQL via Prisma. Single database, tenant-scoped by
  `organizationId`/`workspaceId` on every table that needs it, enforced in a
  query-layer wrapper (`lib/db/scope.ts`), never trusted from client input.
- **Queue**: Redis + BullMQ. Queues: `email-send`, `gmail-sync`,
  `automation-eval`, `ai-jobs`.
- **External**: Gmail API (send + watch + history), Google Pub/Sub (push
  notifications for inbound mail), Gemini API (AI features, fully optional).

## 2. Database ERD (textual)

```
Organization 1─* Workspace
Organization 1─* User
Workspace 1─* Contact
Workspace 1─* Dataset 1─* DatasetColumn
Dataset 1─* Record  (Record.data: jsonb, keyed by column id)
Record *─1 Contact (nullable; resolved by email match)
Workspace 1─* SavedView (scoped to a Dataset)
Workspace 1─* Template 1─* TemplateVersion
Workspace 1─* EmailProviderAccount (Gmail account per user, per workspace)
Workspace 1─* Campaign
Campaign *─1 Template
Campaign *─1 TemplateVersion (snapshot)
Campaign *─1 Automation (nullable, if automation-triggered)
Campaign 1─* CampaignRecord (join: campaign x record, resolved recipient list)
Campaign 1─* Batch
Batch 1─* EmailJob
EmailJob *─1 EmailProviderAccount (sender snapshot)
EmailJob 1─1 ConversationMessage (outbound message it produced, if sent)
Workspace 1─* Automation 1─* AutomationVersion
AutomationVersion 1─* AutomationTrigger / AutomationCondition / AutomationAction
Automation 1─* AutomationRun
Contact 1─* Conversation
Conversation 1─* ConversationMessage
Conversation 1─* InternalNote
Conversation *─* Tag (via ConversationTag)
Conversation 1─* FollowUp
Contact 1─* RecipientHistory (denormalized timeline feed)
Record 1─* RecordChangeHistory
Workspace 1─* Notification (per user)
Organization 1─* AuditLog
Workspace 1─* AiUsage (per user, per day)
ConversationMessage 1─* Attachment
```

Canonical identity rules:
- **Contact** identity key: `(workspaceId, lower(primaryEmail))`, unique.
  Record → Contact linking happens at import time by email match; never
  auto-merges two existing Contacts.
- **Conversation** identity key: `(emailProviderAccountId, gmailThreadId)`,
  unique. Never keyed by subject or recipient address alone (section 45/46).

## 3. Database Schema

Implemented in [`prisma/schema.prisma`](prisma/schema.prisma). Field-level
detail lives there (it's the source of truth); this doc only records the
relationship rules above and the indexing plan (section 99 of the spec),
which is applied via `@@index` / `@@unique` in that file.

## 4. Authentication Architecture

- NextAuth.js (Auth.js) with the Google provider only. No credentials
  provider is registered.
- `signIn` callback rejects any account whose email domain is not
  `masaischool.com` (config: `ALLOWED_EMAIL_DOMAIN`), before a session or DB
  user is ever created. Rejected users see the exact message from spec
  section 5.
- On first sign-in for an allowed domain, a `User` row is created with
  `role = OPERATOR`, attached to the single `masaischool.com` `Organization`
  (bootstrapped by seed) and its default `Workspace` (one workspace per user
  is the Phase-1 default — see §6 model note below).
- Session strategy: database sessions (not JWT-only), so a role change or
  disable takes effect without waiting for token expiry. Session cookie is
  `httpOnly`, `secure`, `sameSite=lax`.
- Every server entry point re-derives `{ userId, organizationId, workspaceId,
  role }` from the session — **never** from a client-supplied body/query
  param. See `lib/auth/session.ts`.

Workspace model note: the spec asks for per-user workspaces conceptually
("Rahul's workspace") but also for shared team workspaces long-term. Phase 1
implements: one `Workspace` per `User` at creation (their personal
operational space), `WorkspaceMember` join table so a workspace *can* later
have multiple members without a schema change, and Super Admin cross-workspace
access via the audited "View as" flow (§9/§128). "View as" is a signed,
HttpOnly, 4-hour cookie (`lib/auth/viewAs.ts`) that `requireSession` resolves
into `session.workspaceId` + `session.viewingAs` — after re-checking on every
request that the workspace is in the admin's organization — so pages and API
routes are scoped by exactly one code path. It is read-only: `requireCanWrite`
takes the whole session and refuses mutations while `viewingAs` is set.

## 5. Gmail OAuth Architecture

- Separate OAuth consent from login: signing in with Google (NextAuth) grants
  identity only (`openid email profile`), **not** Gmail scopes. Connecting
  Gmail is a distinct, explicit step (Settings → Gmail → Connect) that
  requests incremental scopes:
  - `gmail.send`
  - `gmail.readonly` (thread/message fetch for sync + threading headers)
  - `gmail.labels` (optional, for applying a "MailFlow" label)
  - `gmail.metadata` is insufficient because we need body content; historyId
    changes are pulled via `gmail.readonly`.
- Tokens (`access_token`, `refresh_token`, `expiry`, `scope`) are stored in
  `EmailProviderAccount`, `refresh_token` and `access_token` **encrypted at
  rest** with AES-256-GCM using `ENCRYPTION_KEY` (`lib/crypto/secretBox.ts`).
  Never sent to the browser; all Gmail calls happen server-side
  (`lib/gmail/client.ts`), which transparently refreshes and re-encrypts.
- A `User` can have at most one connected `EmailProviderAccount` per
  workspace in Phase 1 (their own inbox). Sending "as" another user requires
  that user's own OAuth grant — never impersonation (§10).

## 6. Gmail Threading Architecture

- Every outbound send stores `gmailMessageId`, `gmailThreadId`, and the RFC
  `Message-ID` header MailFlow generated (or Gmail's own).
- **First message in a conversation**: no `threadId` passed to
  `users.messages.send`; Gmail creates one. We record it.
- **Reply / continue conversation**: pass the stored `gmailThreadId`, and set
  `In-Reply-To` / `References` headers to the prior message's `Message-ID`,
  per RFC 2822 — this is what keeps Gmail (and other clients) threading
  correctly even across long chains, not just the `threadId` field.
- **"New Email" vs "Continue Conversation"** (§54) is a UI-level choice that
  maps directly to "omit threadId" vs "pass stored threadId + headers"।
- A `Conversation` row is the durable identity; `gmailThreadId` alone is not
  assumed stable pre-send (Gmail assigns it on first send), so
  `Conversation.gmailThreadId` is nullable until the first message confirms
  it, then immutable.

## 7. Gmail Inbound Sync Architecture

Event-driven, not polling (§47):

```
Gmail mailbox (per connected account)
   │  users.watch({ topicName: GMAIL_PUBSUB_TOPIC })
   ▼
Google Cloud Pub/Sub topic  → push subscription → POST /api/webhooks/gmail
   │
   ▼
Webhook handler (fast, <1s):
   - verify request (Pub/Sub JWT / shared secret token in the URL)
   - parse { emailAddress, historyId } from the base64 payload
   - enqueue `gmail-sync` job { emailProviderAccountId, historyId }
   - return 200 immediately (ack)
   ▼
gmail-sync-worker:
   - load EmailProviderAccount.lastHistoryId
   - call users.history.list(startHistoryId = lastHistoryId)
   - on 404 (history too old / gap): fall back to a bounded
     users.messages.list(q: "newer_than:2d") reconciliation instead of
     failing silently (§105 "history gaps")
   - for each new/changed message: fetch full message, classify
     (§55 classifier), resolve/create Conversation by
     (accountId, threadId), insert ConversationMessage (idempotent on
     gmailMessageId), update Conversation.lastMessageAt/messageCount,
     update Contact + RecipientHistory, create Notification, mark
     unreadReply on any linked Record
   - persist new historyId (only after successful processing, so a crash
     mid-batch re-processes safely — idempotent inserts make that safe)
```

- `users.watch` must be renewed before its 7-day expiry: a scheduled job
  (`workers/gmail-watch-renew`) re-arms it daily for every connected account.
- Every connected account also has a manual **Sync Now** (§104) that enqueues
  the same job with `historyId = null` → falls back to a bounded recent-message
  scan, for local dev (no public webhook URL) and for recovery.
- Scoped sync, not full-mailbox import (§104): only messages whose thread
  matches an existing MailFlow `Conversation`, or whose `To`/`From` matches a
  known `Contact` and references a MailFlow `Message-ID` in
  `In-Reply-To`/`References`, are ingested. Unrelated personal mail in the
  same inbox is not imported.

## 8. Conversation Architecture

- `Conversation` is keyed by `(emailProviderAccountId, gmailThreadId)`
  (§45/46) — one recipient can have many conversations (different threads),
  and a thread is never merged into another by subject-matching.
- `ConversationMessage.direction` is `INBOUND`/`OUTBOUND`; every message
  stores an immutable content snapshot (§90) — never re-rendered from the
  current template/record state.
- Reply classification (§55) runs synchronously in the sync worker using
  header heuristics first (`Auto-Submitted`, `X-Autoreply`,
  `List-Unsubscribe`, bounce `From` patterns like `mailer-daemon`) and only
  falls back to the Gemini classifier (§80) for ambiguous human-looking
  mail — keeps AI off the hot path and off the free-tier budget for the
  common case.

## 9. Queue Architecture

- BullMQ queues, one Redis instance:
  - `email-send` — one job per `EmailJob` row. Concurrency capped to respect
    §44 rate limit (default 20/min/sender via a BullMQ rate limiter keyed by
    `emailProviderAccountId`).
  - `gmail-sync` — inbound processing, §7 above.
  - `automation-eval` — evaluates one record against one automation version
    on a trigger event; enqueues `email-send`/other action jobs, never sends
    directly.
  - `ai-jobs` — optional async AI calls (summaries), so a slow Gemini call
    never blocks a request thread.
- Idempotency: `EmailJob` has a unique constraint on
  `(campaignId, recordId, templateVersionId)` (§41). The worker upserts on
  that key before calling Gmail; a re-queued/duplicate job for the same key
  is a no-op `SKIPPED`.
- Retry: BullMQ attempts=5, backoff `{ type: 'exponential', delay: 60_000 }`
  giving ~1m/5m/15m-ish spacing per §42; permanent failures (invalid
  recipient, auth revoked) are classified and marked `FAILED` without
  further retries.
- Pause/Resume/Cancel (§43) operate at the `Batch` level: pause stops new
  jobs from being taken off the queue (`queue.pause()` scoped via a
  per-batch flag checked in the worker before each send, since BullMQ pause
  is queue-wide); cancel marks remaining `QUEUED` `EmailJob`s `CANCELLED` and
  the worker skips them; in-flight jobs finish.

## 10. Automation Architecture

- `Automation` → `AutomationVersion` (immutable once any run references it,
  §73) → `AutomationTrigger` (one of: record-matches-condition,
  record-created, record-updated, manual, scheduled) +
  `AutomationCondition[]` (AND/OR tree, stored as nested JSON for MVP) +
  `AutomationAction[]` (send-email / update-record / wait / notify-user, in
  order).
- Evaluation entry points:
  - Record write path (`lib/records/write.ts`) always calls
    `evaluateAutomationsForRecord(record, trigger: 'CREATED'|'UPDATED')`
    after a successful write, which enqueues `automation-eval` jobs for every
    *enabled* automation in the workspace whose trigger type matches.
  - Scheduled trigger: a cron-style worker (`workers/automation-cron`) scans
    due schedules.
- `automation-eval` worker re-checks the condition tree against current
  record state (fresh read, not stale), checks stop conditions and
  frequency policy (§37 — `sendOncePerCampaign` / `cooldownDays`) via
  `AutomationRun` history, writes an `AutomationRun` row with the
  input/output/error either way, and only then enqueues the action (e.g. an
  `EmailJob`) — so `AutomationRun` is a full audit trail (§72) independent of
  whether an email was actually sent.
- Enabling an automation always shows the §74 confirmation
  ("Automation Ready — Potential records: N") computed by dry-running the
  condition tree against the current dataset before flipping `enabled=true`.

## 11. AI / Gemini Architecture

- `lib/ai/provider.ts` defines the `AIProvider` interface (§83):
  `generateText, generateEmail, improveText, summarizeConversation,
  classifyReply, suggestReply`. `lib/ai/gemini.ts` implements it against the
  Gemini API using `GEMINI_API_KEY` / `GEMINI_MODEL` from env — never
  hardcoded, never sent to the client.
- Every call goes through `lib/ai/guard.ts`: per-user daily counter and
  per-organization daily counter in `AiUsage`, checked *before* calling
  Gemini; timeout (10s) + up to 2 retries on 429/5xx with backoff; on
  exhaustion or provider error, returns a typed `{ ok: false, reason }`
  result — callers degrade to "AI unavailable, continue manually" (§82/§142),
  never a 500, and email sending never depends on AI succeeding.
- Prompts are built from minimal context (template text, last N conversation
  messages' plain text, resolved variables) — never OAuth tokens, never raw
  DB rows beyond what's needed (§81). Every call is logged in `AiUsage`
  (feature, tokens if available, success/failure, latency), never the full
  prompt/response body by default (configurable, off by default, to avoid
  storing student PII in logs beyond necessity).

## 12. Multi-Tenant Security Model

- Every table with tenant data carries `organizationId` (and usually
  `workspaceId`). All reads/writes go through `lib/db/scope.ts` helpers
  (`scopedPrisma(session)`) that inject the tenant filter — application code
  cannot "forget" the where-clause because the helper requires the session
  object to construct a client-safe query.
- `lib/auth/session.ts` is the *only* place identity is derived, from the
  server session — API routes and Server Actions must call
  `requireSession()` / `requireRole([...])` first; they never read
  `userId`/`workspaceId`/`role` from the request body.
- `requireRole` throws a typed `ForbiddenError` → route returns 403; enforced
  centrally, not per-page, and mirrored (not replaced) by hiding UI for
  lower roles.
- SUPER_ADMIN cross-workspace reads use a distinct
  `scopedPrisma(session, { asSuperAdmin: true })` path that still requires
  `role === SUPER_ADMIN` server-side and writes an `AuditLog` row
  (`action: 'ADMIN_VIEW'`) for every such query touching another user's
  workspace (§9/§128).
- Gmail send/authorize is never granted by role alone (§10): sending as user
  X requires `EmailProviderAccount` row owned by X with a valid token; a
  SUPER_ADMIN viewing X's workspace cannot trigger a send from X's Gmail
  without X's own OAuth grant existing.

## 13. Folder Structure

See repository tree; mirrors spec §101 (`/app`, `/components`, `/lib`,
`/workers`, plus `/prisma`, `/tests`).

## 14. API Design

REST-ish Next.js route handlers under `app/api/**`, matching spec §102
verbatim where given; see `docs/API.md` for the full, current list as it's
implemented (kept close to code so it doesn't drift).

## 15. Implementation Plan / Phase Status

Tracked in [`PHASE_STATUS.md`](PHASE_STATUS.md) — updated as each phase
lands. Phases follow spec §138 exactly (Phase 1 → 8). Nothing is marked done
until it has a working DB-backed API route, a UI that calls it, and
server-side authorization — per §139/§140, no fake functionality: an
unfinished feature is left visibly marked "Not yet implemented" in the UI
and in `PHASE_STATUS.md`, never faked.
