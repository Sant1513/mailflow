# Phase status

## Deployment

- **Live:** https://mailflow-six-sooty.vercel.app (Vercel, production)
- **Database:** Neon Postgres (schema migrated, `prisma/migrations/`)
- **Repo:** https://github.com/Sant1513/mailflow

## Verification status (last run: 6 Sep 2026, after Phase 6)

| Suite | Count | Result |
| --- | --- | --- |
| Unit tests (`npm test`) | 306 | ✅ pass |
| Live-DB integration (`scripts/smoke-test-db.ts`) | 19 | ✅ pass |
| Send pipeline, live DB + fake provider (`scripts/smoke-test-send.ts`) | 35 | ✅ pass |
| Automation engine, live DB (`scripts/smoke-test-automation.ts`) | 28 | ✅ pass |
| Inbound ingestion + sync, live DB + fake Gmail (`scripts/smoke-test-inbox.ts`) | 32 | ✅ pass |
| Inbox/conversation HTTP, real session (`scripts/smoke-test-inbox-http.ts`) | 23 | ✅ pass |
| HTTP integration (`scripts/smoke-test-http.ts`) | 37 | ✅ pass |
| Super Admin view-as / analytics / retention HTTP, real session (`scripts/smoke-test-admin-http.ts`) | 37 | ✅ pass |
| Deployment verification (`scripts/verify-deployment.ts`) | 19 | ✅ pass |
| `tsc --noEmit` / ESLint / `next build` | — | ✅ clean |

**The full loop is verified against real Gmail** (5 Sep 2026, mailbox
`abhishesh.kumar@masaischool.com`): a campaign email was sent through the
real pipeline (Gmail id `1a0739611a8fe148`), the recipient's real reply was
synced into the Inbox (scan path on the first run, then the `history.list`
path with a persisted cursor on the second, both against the live mailbox),
and an in-thread reply was sent from the app's composer with a correct
three-message `References` chain. Scope held on a real mailbox: 1 of 100
recent messages ingested, 99 ignored.

That round-trip exposed one real bug the fake provider had hidden: **Gmail
replaces the MIME `Message-ID` on send** with its own `<…@mail.gmail.com>`
value, so we were storing an ID no reply would ever cite. Threading survived
only via the thread-id match. `GmailProvider` now reads the assigned
Message-Id back after every send (`tests/email/gmailProvider.test.ts`), and
the one pre-fix message was backfilled.

Not yet exercised live: Pub/Sub push delivery (`GMAIL_PUBSUB_TOPIC` unset;
Sync Now and the webhook path are tested with a fake source), and attachment
byte download.

Honest, current status of the spec's §138 phases. "Done" means: real DB-backed
API route + UI calling it + server-side authorization + (where practical) a
test. Nothing is marked done on UI alone (§139/§140).

## Phase 1 — Foundation ✅ mostly done
- [x] Google OAuth login (`lib/auth/options.ts`); sign-up is open by default and lockable to one domain via `ALLOWED_EMAIL_DOMAIN`
- [x] Organization / Workspace / User / WorkspaceMember schema, RBAC roles
- [x] Role enforcement in `lib/auth/session.ts` (`requireSession`, `requireRole`) — server-side, not just hidden nav
- [x] Super Admin cross-workspace read path (`lib/permissions/workspace.ts`) + audit on admin view
- [x] Postgres schema for the full domain model (`prisma/schema.prisma`)
- [x] Airtable-style data table: inline edit, add/delete row, add column, **change column type** (`components/data-grid/DataGrid.tsx`)
- [x] Paste / CSV / XLSX import with preview → type inference → duplicate handling → commit (`lib/imports/parse.ts`, `/api/datasets/import*`) — **import never sends email**; bulk insert, so large imports do not time out
- [x] Contacts as a first-class entity, resolved by email at import/edit time, with a bulk backfill when a column is retyped to EMAIL (`lib/records/contactLink.ts`)
- [x] Record change history on manual edits (`RecordChangeHistory`)
- [x] Audit logging framework (`lib/audit/log.ts`) wired into every mutation
- [x] Admin: Users (role/status management), Audit Logs, Organization stats, Workspaces list, All Data — real queries
- [x] Deployed to Vercel against a live Neon Postgres, with integration tests run against the deployed instance
- [ ] Column reorder/resize/hide UI, saved views, filter/sort/group UI, bulk select/update, freeze columns, virtualization — grid backend (hidden/order/width columns) exists in schema; UI controls not built yet
- [ ] "View as" banner + Exit View UX (server-side access + audit already enforced)

## Phase 2 — Templates ✅ done
- [x] Template CRUD + duplicate + archive (`/api/templates*`), workspace-scoped and RBAC-enforced
- [x] Delete is refused when a campaign references the template — it archives instead, so historical campaigns keep their content (§21/§126)
- [x] **Versioning**: every save creates a new immutable `TemplateVersion`; identical content is a no-op instead of inflating version numbers; old versions are never mutated
- [x] Three-pane editor (settings / HTML+CSS code editor / live preview) with CodeMirror
- [x] **Variables** (`{{Name}}`): extraction, `+ Insert variable` menu populated from the dataset's real columns, resolved-value panel
- [x] **Personalized preview** — "Preview as \<record\>" renders against a real dataset record; desktop/mobile widths
- [x] **XSS-safe preview**: values are HTML-escaped on substitution, template HTML is sanitized server-side, and the result renders in an iframe with an empty `sandbox` (no scripts) — 12 attack vectors covered by tests
- [x] **Email health check** (§27): subject, body, variable validity against the dataset, recipient column, sender connection, brace typos, links, images, plain-text alternative, Gmail's ~102KB clipping threshold. Fails block; warnings don't.
- [x] Plain-text alternative auto-generated from HTML when not supplied
- [x] Send test email (§26) — lives in Phase 3 below, since it needs a connected mailbox
- [ ] Rich-text (WYSIWYG) editing mode — HTML/CSS editing works; a visual drag-and-drop builder is a later refinement.

## Phase 3 — Gmail + Campaigns + Queue ✅ mostly done
- [x] Gmail OAuth as a **separate** consent step from login; CSRF-protected callback, scope verification, and a refusal to connect a mailbox that isn't the signed-in user's own
- [x] Tokens AES-256-GCM encrypted at rest, auto-refreshed, never sent to the browser
- [x] `EmailProvider` abstraction + `GmailProvider`; nothing outside `lib/email/*` and `lib/gmail/*` touches the Gmail SDK
- [x] RFC 2822 MIME builder: multipart/alternative, attachments, RFC 2047 headers, and **In-Reply-To / References threading** (§46) — plus CRLF stripping so a template variable can't inject headers
- [x] Campaign CRUD, with the template version **pinned at creation** (§21/§126)
- [x] **Pre-send review** (§113): exact headers, per-recipient outcome with reasons, rendered personalized email per recipient, template cross-check, health check — read-only, sends nothing
- [x] **From name, Reply-To, CC, BCC** on campaigns (§22); the From *address* is deliberately locked to the connected mailbox (§28); CC/BCC volume multiplier shown explicitly
- [x] **Dry run** sharing one pure evaluator with the real send, so the simulation genuinely predicts the send; every record gets a reason
- [x] "Why was this sent" recorded on every job; never blank (§35)
- [x] Approval workflow — server-enforced: only ADMIN/SUPER_ADMIN approve, nobody approves their own campaign (SUPER_ADMIN excepted)
- [x] Batches + one immutable `EmailJob` snapshot per recipient (rendered body + sender identity + Reply-To)
- [x] Duplicate protection enforced by a **DB unique constraint** on (campaign, record, templateVersion), not just app logic
- [x] Pause / resume / cancel, re-checked immediately before each send
- [x] Retry that classifies failures — permanent ones (invalid recipient, revoked auth) are never retried
- [x] Rate limiting from durable rows, so the cap survives restarts
- [x] BullMQ + Redis worker (`npm run worker:email`) **and** a bounded drain endpoint for deployments without Redis — both call the same `processEmailJob`
- [x] Test email (§26) — exactly one message, clearly marked, never to campaign recipients
- [ ] Scheduling: `scheduledAt` is stored and shown, but no scheduler process dispatches it yet — a scheduled campaign still needs Send pressed
- [ ] Attachments on campaigns (the MIME builder supports them; the campaign UI does not expose them yet)

## Phase 4 — Automation builder ✅ mostly done
- [x] Condition engine: AND/OR trees, 8 operators, with type-loose comparison so `Trigger = 1` matches the string `"1"` people actually type
- [x] Unknown operators **fail closed** (never send) rather than passing
- [x] Trigger → conditions → action builder UI, with the run log
- [x] Stop conditions (§71) evaluated **before** trigger conditions, so "already replied" wins
- [x] Send-frequency policy (§37): once / per day / per week / per campaign / repeated, plus an N-day cooldown that takes the stricter of the two
- [x] Actions: SEND_EMAIL (creates a real campaign/batch/job, so automated mail appears in history exactly like manual mail), UPDATE_RECORD (with change history), NOTIFY_USER
- [x] Automation versioning (§73) — editing creates a new version **and turns the automation off**, so the new rules must be re-confirmed before they can fire
- [x] §74 safety gate: enabling requires the caller to echo back the affected-record count it was shown, so mass email cannot be switched on without the number being displayed
- [x] Run log records every evaluation including the no-ops (§72)
- [x] Evaluation hooked into record create/update; a failing automation never blocks a data edit
- [ ] WAIT action — recorded as not-implemented in the run log rather than faked; needs the delayed queue
- [ ] SCHEDULED trigger — stored but no cron process runs it yet

## Phase 5 — Threading / inbound sync / Inbox ✅ mostly done
- [x] Gmail message parser (`lib/gmail/parseMessage.ts`): base64url bodies, nested multipart, attachments, address lists, threading headers — pure, 19 tests
- [x] **Header-first classification** (`lib/conversations/classify.ts`, §55): bounce / delivery-failure / out-of-office / auto-reply / human, by RFC 3464/3834 signals before subject heuristics — 22 tests. Only a human reply counts as "the student replied".
- [x] **Ingestion** (`lib/gmail/ingest.ts`): conversation identity is `(mailbox, gmailThreadId)` — never subject, never address alone (§45). Replies match to what we sent via `In-Reply-To`/`References` against our stored `Message-ID`s (§46).
- [x] **Scoped sync** (§104): only mail tied to a MailFlow thread, a Message-ID we sent, or a known contact is ingested — the rest of the mailbox is left alone
- [x] **Idempotent** on `gmailMessageId` (§48): a redelivered notification stores nothing twice
- [x] Inbound updates record system fields only (`replyReceived`, `unreadReply`, `lastReplyAt`, thread id) — business columns untouched (§14); bounces update nothing
- [x] **History-based sync** (`lib/gmail/sync.ts`): `users.history.list` from the stored cursor, with a bounded recent-INBOX scan fallback when history has expired (§105); cursor advances only after the window is processed
- [x] **Pub/Sub webhook** (`/api/webhooks/gmail`): token-verified, acks fast, queues the sync (or runs it inline without Redis)
- [x] **Sync Now** (§104) for environments without push
- [x] **Inbox** (§51/§109): filter rail with live counts (unread / mine / open / waiting / resolved / all), search across name, address, subject, message text and thread id (§64)
- [x] **Conversation view** (§50/§110): one chronological timeline of messages *and* internal notes, formatted-body toggle in a sandboxed iframe, attachment listing
- [x] **Reply from the app** (§53) in the same Gmail thread with correct `In-Reply-To`/`References`; **"start a new thread"** is an explicit opt-in (§54); replies from the caller's *own* mailbox only
- [x] Read state (§52) kept in sync between the inbox badge and the record grid
- [x] Internal notes in their own table — no code path can send one (§58)
- [x] Tags, status, assignment (with notification), follow-ups (with record flag) — all audited (§56/§57/§59/§60)
- [x] **Recipient timeline** (§61) on the contact page: campaign sends, replies, automated mail, notes, status changes, follow-ups, in order
- [x] NEW_REPLY / ASSIGNMENT notifications (§87)
- [ ] Gmail `users.watch` renewal worker — push subscriptions expire after 7 days and are not yet re-armed automatically (manual Sync Now still works)
- [ ] `gmail-sync` BullMQ worker process (the webhook queues to it when Redis is present; without Redis it syncs inline)
- [ ] Attachment *download* — metadata is stored; fetching the bytes via `attachments.get` is not wired yet

## Phase 6 — Super Admin analytics/org management — done (6 Sep 2026)
- [x] §127 Organization analytics: Users / Active users / Workspaces / Contacts / Datasets / Campaigns / Emails sent / Failed / Replies / Open / Resolved / AI calls, all live counts (`lib/analytics/metrics.ts`)
- [x] Charts: Emails by day, Replies by day, Failure rate (null, not 0, on days with nothing attempted), Campaign performance table, User activity table; 7/30/90-day window, bucketed in IST
- [x] §86 Dashboard: Emails sent / Pending / Failed / Replies / Unread / Open conversations / Follow-ups due, 30-day chart, recent batches, recent conversations, recent activity, quick actions
- [x] §9 "VIEWING WORKSPACE AS … [ Exit View ]": signed HttpOnly cookie resolved inside `requireSession` so every page and API route is scoped identically; org membership re-checked on every request; entry and exit audited; **read-only** — `requireCanWrite(session)` refuses every mutation while viewing (§10: never touches the owner's Gmail)
- [x] §130 Retention policy: per-org config (message bodies / sent-email snapshots / audit rows, ≥30 days or keep forever), live "would affect N rows" preview, audited with a before/after diff. **No enforcement job exists** — saving a policy deletes nothing, by design ("do not delete historical communication accidentally"); enforcement is a future explicit, audited action
- [x] System Settings page: retention UI + read-only view of runtime env (sign-in restriction, rate limit, AI key presence)
- [ ] Workspace management actions (create / rename / disable / move users) — listing exists, mutations not yet
- [ ] Retention enforcement (deliberately deferred, see above)

## Phase 7 — Gemini AI — not started
`AiUsage` table exists. No `AIProvider`/`GeminiProvider` implementation yet.

## Phase 8 — Advanced analytics / integrations — not started

---

### Immediate next steps (in order)
1. ~~Connect a real Gmail account and verify the Google round-trip~~ — **done**: real send, real inbound sync (scan + history paths), real in-thread reply, all against the live mailbox.
2. ~~Phase 6: organization analytics, the "view as" banner, retention policy~~ — **done** (retention enforcement and workspace mutations deferred, see Phase 6).
3. Phase 7: `AIProvider` + `GeminiProvider` with per-user/org rate limits; reply suggestion, summary, classification behind the header-first classifier.
4. Close out Phase 1: saved views, filter/sort/group, bulk edit on the grid.
5. Scheduling dispatcher (Phase 3) and the `WAIT` action / `SCHEDULED` trigger (Phase 4) — both need the delayed queue.
