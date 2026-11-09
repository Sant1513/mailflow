# Phase status

> **Update 10 Nov 2026:** this file is the detailed log of Phases 1–7 up to
> 10 Sep, followed by everything shipped from 27 Sep to 9 Nov (see
> [October–November 2026](#octobernovember-2026)), what was
> [replaced or removed](#replaced--removed), and the [open items](#open-items).
> Mail round 3, MailFlow Sign (S1–S6), the Mail/Sign split and the 27 Sep
> automation pack are summarised in the [README](README.md#phase-status).
> Unit tests: 68 files in `tests/` (the count was not re-run for this update).

## Deployment

- **Live:** https://mailflow-six-sooty.vercel.app (Vercel Hobby, functions in Mumbai `bom1`, Node 26.x)
- **Database:** Supabase Postgres (free plan, Mumbai), schema in `prisma/migrations/`, applied by the build (`prisma migrate deploy`)
- **Files:** Supabase Storage; final signing files archived to the laptop
- **Standby:** the laptop server (`laptop-server/`), switchable to active on Settings → Server
- **Repo:** https://github.com/Sant1513/mailflow

## Verification status (last run: 10 Sep 2026, after the Gmail sync rework)

| Suite | Count | Result |
| --- | --- | --- |
| Unit tests (`npm test`) | 402 | ✅ pass |
| Live-DB integration (`scripts/smoke-test-db.ts`) | 19 | ✅ pass |
| Send pipeline, live DB + fake provider (`scripts/smoke-test-send.ts`) | 35 | ✅ pass |
| Automation engine, live DB (`scripts/smoke-test-automation.ts`) | 28 | ✅ pass |
| Inbound ingestion + sync, live DB + fake Gmail (`scripts/smoke-test-inbox.ts`) | 34 | ✅ pass |
| Inbox/conversation HTTP, real session (`scripts/smoke-test-inbox-http.ts`) | 23 | ✅ pass |
| HTTP integration (`scripts/smoke-test-http.ts`) | 37 | ✅ pass |
| Super Admin view-as / analytics / retention HTTP, real session (`scripts/smoke-test-admin-http.ts`) | 37 | ✅ pass |
| AI assistant, real session + **real Gemini** (`scripts/smoke-test-ai.ts`) | 34 | ✅ pass |
| Grid: views / filter / sort / group / columns / bulk HTTP, real session (`scripts/smoke-test-grid-http.ts`) | 36 | ✅ pass |
| Campaign approvals: submit / list / search / approve / reject / audit / charts HTTP (`scripts/smoke-test-approvals-http.ts`) | 27 | ✅ pass |
| Batches / History / All Conversations pages + "no placeholders" sweep (`scripts/smoke-test-pages-http.ts`) | 26 | ✅ pass |
| Inbox composer / rendering / assignment + resolution notifications (**real Slack thread**) / snippets / bell / follow-up cron (`scripts/smoke-test-inbox-notify-http.ts`) | 37 | ✅ pass |
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
- [x] Deployed to Vercel against a live Postgres (Neon then; Supabase since 2 Nov 2026), with integration tests run against the deployed instance
- [x] Grid (7 Sep 2026): server-side **filter** (same AND/OR condition engine as automations, incl. `__emailStatus`-style system fields), **search** across all columns, **sort** by header click (up to 3 keys, empties always last), **group** with counts, **pagination** (25–200/page; the browser only ever gets one page, §135) — `lib/records/query.ts`, `GET /api/datasets/[id]?filter&sort&search&groupBy&page&viewId`
- [x] **Saved views** (`SavedView`): create / update / save-as / delete, applied via `?viewId=`, explicit params override the view; audited
- [x] **Columns**: show/hide, rename, delete, reorder (`PATCH /api/datasets/[id]/columns` with the full id order), resize by dragging the header edge (persisted width), freeze first column
- [x] **Bulk select → bulk set value / bulk delete** (`POST /api/datasets/[id]/records/bulk`, ≤1000 ids, only ids inside the dataset): per-record change history, contact re-link, RECORD_UPDATED automations evaluate per record, audited with counts. **Duplicate row**
- [x] Virtualization (2 Nov 2026, `f3313d7`) — grid pages in the database and filters read only the columns they use, so the limit went from 5,000 to 100,000 rows; the grid draws only the visible rows; 500 / 1,000-row pages
- [x] "View as" banner + Exit View UX — shipped in Phase 6 (signed cookie, read-only, audited)

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
- [x] Scheduling (16 Sep): schedule picker on send; BullMQ delayed jobs when Redis is present, otherwise the 15-minute `/api/cron/dispatch` starts the sender and it releases the campaign once `scheduledAt` passes (within about 15 minutes); `/api/cron/scheduled-send` stays as the daily backstop
- [x] Per-recipient personalised PDF attachments on campaigns (15 Sep, PDF Library); arbitrary file attachments on campaigns are still not exposed

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
- [x] WAIT action (15 Sep): enqueues a delayed BullMQ job and resumes mid-sequence (`npm run worker:automation`). **Needs Redis** — production has none today, so WAIT is currently a no-op there
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
- [x] Gmail `users.watch` start and renewal (2 Nov 2026, `660a1b7`, `lib/gmail/watch.ts`, renewed from the gmail-sync cron) — **off until `GMAIL_PUBSUB_TOPIC` is set** and the Pub/Sub topic and push subscription exist; until then the 30-minute sync and auto-sync on open apply
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

## Feedback round 2 — composer, rendering, Slack + email notifications, CRM extras (9 Sep 2026) — done
Spec: docs/requests/2026-09-09-inbox-composer-notifications.md
- [x] **Reply composer** (components/inbox/ReplyComposer.tsx): Write (rich text: bold / italic / underline / lists / link / clear), HTML (code editor + Format), Preview (exact email, From + subject, 320–1200 px width slider + Desktop/Mobile). Insert link, Insert snippet, AI suggest reply, **attachments** (4 MB total per reply — the serverless body limit; real MIME parts via the Gmail path; stored as Attachment rows on the outbound message). Plain-text alternative generated from the HTML
- [x] **Message rendering**: every message shows its sanitised HTML by default in a self-sizing frame (no inner scrollbar, no script: sandbox without allow-scripts); plain-text messages get paragraphs + clickable links; **quoted history collapsed** (Gmail / Outlook / Apple Mail / Yahoo / Thunderbird markers and "On … wrote:" / ">" lines) behind "Show quoted text"; split happens server-side, raw HTML never reaches the browser
- [x] **Assignment → email + Slack + bell**; **resolution → same email thread + same Slack thread** (In-Reply-To/References; Slack thread_ts + ✅ reaction). Email from the assigner's Gmail (fallback: the conversation's mailbox), Slack mention by the user's Slack member ID. Best effort with recorded outcomes (returned in the PATCH response, shown in the toast, audited as CONVERSATION_NOTIFY). Thread ids stored on the conversation
- [x] **Slack settings** on System Settings: channel ID, bot + channel status, Send test message, switches for assignments / resolutions / follow-ups (IntegrationSettings). Token is SLACK_BOT_TOKEN in the environment only
- [x] **Slack member ID per user**: Users page (super admin) and each person's own Settings page (/api/me)
- [x] **Saved replies** (ReplySnippet, /api/snippets): per workspace, {{Name}} / {{FirstName}} / {{Email}} / {{Sender}} / dataset columns resolved for the conversation's student at insert time, unknown variables kept visible; managed in Settings
- [x] **Notification bell** (§87): unread count, list, mark read, in the sidebar and the mobile bar; polls every 60 s
- [x] **Follow-up reminders**: /api/cron/follow-ups (CRON_SECRET) → one in-app notification + one Slack thread reply per due follow-up (remindedAt guarantees once). Scheduled hourly by GitHub Actions (every 15 min until Nov 2026) (.github/workflows/follow-up-reminders.yml) with a daily Vercel cron backstop at 09:00 IST, since Vercel Hobby allows only daily crons
- [x] **Replies sent straight from Gmail now show in the thread** (10 Sep): the sync used to ingest only non-own INBOX messages, so a reply typed in Gmail (SENT label) never reached MailFlow. Now a message from the mailbox's own address in a known MailFlow thread is stored as OUTBOUND ("Replied from Gmail" in the student's history), and unknown threads stay untouched
- [x] **Sync rework for busy mailboxes** (10 Sep, lib/gmail/sync.ts): the team mailbox sees ~900 new messages in two days, and fetching each in full took 15+ minutes and timed out on Vercel, so the cursor never advanced. The loop now triages from history.list's own thread + label data (drafts / spam / trash and already-stored ids dropped without a fetch, known threads fetched in full, own mail in unknown threads skipped), fetches only metadata (From / In-Reply-To / References) for the rest with six parallel calls, bulk-checks Contacts and sent Message-IDs per batch of 40, and runs under a wall-clock budget with the history cursor advanced to the last record fully processed, so a run that stops early resumes (`remaining` in the response; Sync Now / auto-sync / cron loop until drained). Measured: 925-message backlog drained in 68 s in two rounds, zero errors. Route `maxDuration = 60`
- [x] **Auto-sync**: the Inbox list and every conversation page pull the mailbox on open when it was last synced more than 2 minutes ago (`POST /api/gmail/sync?ifStaleMinutes=2`, EmailProviderAccount.lastSyncAt); `/api/cron/gmail-sync` syncs every connected mailbox every 15 min from the GitHub Actions schedule (daily Vercel backstop). Sync Now still works as the explicit path
- [ ] Later: SLA highlighting for threads waiting > 48 h, @mentions in notes, per-student do-not-contact flag, CSV export of grid views, inbox keyboard shortcuts

## Feedback round 1 — approvals, themes, responsive, editor (7 Sep 2026) — done
Spec: docs/requests/2026-09-07-approvals-theme-ux.md
- [x] **Approvals page** (/approvals) for ADMIN + SUPER_ADMIN: Pending / Approved / Rejected / All tabs, search by campaign, requester or workspace, approve and reject with a required **reason** (sent to the requester) and optional **remarks** (internal), waiting time, reviewer, email outcome per request. Pending badge in the nav. SUPER_ADMIN sees the organisation; ADMIN sees their own workspace plus workspaces where they hold an ADMIN membership (lib/permissions/reviewer.ts)
- [x] **Request email** on submit from the requester's Gmail to every SUPER_ADMIN + the workspace's ADMINs, requester in Cc; **decision email in the same thread** (In-Reply-To / References; same Gmail thread id when the same mailbox sends both) from the reviewer's mailbox, falling back to the requester's. Best effort: no mailbox or a Gmail failure never blocks the decision — the outcome is stored on the campaign (approvalRequestEmail / approvalDecisionEmail) and shown. The live send is the same GmailProvider path verified in Phase 5; fixture users have no mailbox, so the smoke suite asserts the recorded SKIPPED outcomes
- [x] **Reports**: requests / approvals / rejections by day with pending, approved, rejected, median wait and oldest-pending on the Dashboard (workspace) and Organization page (org)
- [x] **Light / dark / system theme**: tokens restructured (light is :root, .dark swaps), pre-paint script (no flash), toggle in the sidebar, mobile bar and login; charts read CSS tokens
- [x] **Responsive**: sidebar becomes a top bar + drawer below lg; conversation page stacks; template editor becomes Settings / Code / Preview tabs; popovers clamp to the viewport; full-height pages use the shell height
- [x] **Template formatting**: HTML pretty-printer (lib/templates/format.ts) applied to every AI insert plus a Format button; adds only whitespace between block elements — a test proves the rendered structure is unchanged
- [x] **Template editor sizing**: draggable dividers between the three panes (remembered per browser) and a 320–1200px preview width slider alongside the desktop/mobile presets
- [x] **Last placeholders replaced** (7 Sep): **Batches** (`/batches`, `GET /api/batches` — every batch in the workspace with live progress, queued count, pause / resume / process queue / retry failed / cancel, auto-refresh while in flight), **History** (`/history`, `GET /api/history?direction=sent|received` — every EmailJob outcome and every inbound message with its classification, search + status filters, "Why?" per send), **All Conversations** (`/admin/conversations`, SUPER_ADMIN, org-wide with workspace / status / search filters, audited). The template editor's From box now shows the connected mailbox. `PendingFeature` is deleted; a smoke check asserts no "not yet implemented" copy on any main page (`scripts/smoke-test-pages-http.ts`, 26 checks)

## Phase 7 — Gemini AI — done (6 Sep 2026)
- [x] §83 `AIProvider` abstraction (`lib/ai/types.ts`) with `GeminiProvider` (`lib/ai/gemini.ts`): REST `generateContent`, JSON response schemas (typed output, no prose parsing), 30s timeout, 2 retries with backoff + Retry-After, 429 → `RATE_LIMITED`, safety blocks and malformed JSON surfaced as their own kinds. Key in a header, never a URL. Configurable via `GEMINI_API_KEY` / `GEMINI_MODEL` (default `gemini-3.6-flash`; verified live)
- [x] §81/§82 policy in one place (`lib/ai/service.ts`): `AI_ENABLED`, per-user and per-org daily limits (`AI_USER_DAILY_LIMIT` 100 / `AI_ORG_DAILY_LIMIT` 1000, IST days), every call logged to `AiUsage` (feature, success, tokens, latency, error reason), every failure mapped to a graceful "you can continue manually" outcome — the AI being down never fails a page or a sync
- [x] §81 context minimisation (`lib/ai/prompts.ts`): last 8 turns only, quoted tails and signatures stripped, email addresses and phone numbers redacted, per-message cap; first names only. Tokens/secrets are never in scope
- [x] §76/§77 template editor assistant: generate email (subject, preview, text, HTML) → Insert / Regenerate / Make shorter / More professional; improve current body (improve, shorten, professional, friendly, grammar, CTA, rewrite, translate); subject ideas; personalisation check (missing variables computed locally, quality judged by AI)
- [x] §78 reply assistant in the conversation: AI suggest reply → Insert / Regenerate / Make shorter / More formal. Sending stays the human-only button
- [x] §79 conversation summary + suggested next action + suggested status shown as a button the human presses; never applied automatically
- [x] §80 reply intent (COMPLETED / QUESTION / REQUEST / COMPLAINT / ACKNOWLEDGEMENT / NEEDS_ACTION / OUT_OF_OFFICE / AUTO_REPLY / UNKNOWN) with confidence, stored on the message **beside** the header-first classification (`aiIntent*` columns, migration); ingest annotates human replies best-effort with a 12s cap; no record or status is ever changed by the AI
- [x] §76 items 18–20: campaign summary, "Why?" per sent job (from the immutable send snapshot + `sendReason`), "Why?" per automation run
- [x] "AI usage today: N / limit" on every panel; System Settings shows provider, model, enabled flag, limits and org-wide usage
- [x] `/api/ai`: one endpoint, discriminated actions, workspace ownership checked per row, read-only under "view as" (no annotation written)
- [ ] Translate targets other than Hindi in the UI (API accepts any language)
- [ ] Per-org AI on/off in the database (today it is the `AI_ENABLED` env flag)

## Phase 8 — Advanced analytics / integrations 🟡 in progress
- [x] Outbound webhooks, SLA rules, Performance, campaign analytics (17 Sep, see README)
- [x] Mail → Deliverability (2 Nov): bounce and unsubscribe rates against thresholds, each mailbox's 24-hour usage, SPF / DKIM / DMARC check, recent bounces
- [x] Grid virtualisation and Gmail push watch (2 Nov, see Phases 1 and 5)
- [x] Organization → "Everything sent" ledger (6 Nov)
- [ ] Spam-complaint tracking (see [Open items](#open-items))

## October–November 2026

Grouped by area; dates are commit dates. ✅ shipped · 🟡 partial · ⬜ open.

### Sending at scale (7–16 Oct) ✅
- ✅ Campaigns send automatically, 3 s apart, instead of stopping after 20 (`b5d2855`); the sender survives errors and stays inside Google Workspace limits (`184cdcf`, `a76d31a`: 1,500 messages / 1,800 unique / 9,000 total recipients per mailbox per rolling 24 h)
- ✅ Backup sender mailboxes for campaigns, up to 5 in order (`ef69462`)
- ✅ **Quick Send**: a whole campaign on one screen, with attachments, a test send, templates and approvals (`81bd589` … `9578736`)
- ✅ Sent emails start as "Waiting for student" (`9c1cbbf`); pasted HTML renders as designed (`b0a0972`)

### Hosting (19 Oct – 6 Nov) ✅
- ✅ Laptop server with Vercel as the front door, Tailscale Funnel watch and repair, restart on request (`276964d`, `3ebf94c`, `e0259c2`, `a083b36`)
- ✅ **Move to Supabase** (Mumbai) after Neon's free compute ran out on 19 Oct; Vercel functions in `bom1` next to it (`8887bcb`, export/import tools `4c14b9c`)
- ✅ **Server switch**: MailFlow runs on the cloud or the laptop, one at a time (`SystemState`, `lib/system/serverState.ts`, `e1c7e9b`, `e423cbf`)
- ✅ File storage: signing attachments and signed PDFs in Supabase Storage, archived to the laptop when final, cloud copy deleted (`031c5df`)
- ✅ Stay inside Vercel Hobby (`2683e8c`, `a6b55a3`, `8d54d8f`): small `@googleapis/gmail` / `people` / `sheets` packages plus `google-auth-library` (`googleapis-common` pinned to 9.0.0), `ignoreCommand` (`scripts/vercel-ignore.sh`) skips builds for tests / laptop-server / workflows / docs, one cheap `/api/cron/dispatch` every 15 minutes, Gmail sync every 30 minutes, follow-ups and Sheets sync hourly, Node pinned to 26.x
- 🟡 Gmail sync works through a big backlog window by window (`9a0df08`); Gmail push watch built but off until `GMAIL_PUBSUB_TOPIC` is set (`660a1b7`)

### Inbox and deliverability (2–9 Nov) ✅
- ✅ Bounce suppression from Gmail's later delivery-failure emails; one conversation access rule (FULL / REPLY / WORK / VIEW); **inbox sharing** with "My inbox / Shared with me" (`2efc830`)
- ✅ Bot-click filtering, pre-send address checks (dead domains, typos, no-reply, throwaway), **Deliverability** page (`89d73f8`)
- ✅ Hard bounces from any tool or user suppressed **org-wide** with the reason (`44863b3`); `syncOrgBounces` fills gaps from the daily-report cron (`f957766`)
- ✅ Inbox replies and scheduled replies refuse bounced or complained addresses (`lib/email/replySuppression.ts`, `fbdb742`)
- ✅ Deliverability bounce rate counts only the workspace's own campaign bounces (`fbdb742`)
- ✅ **Unsubscribe button on every bulk email**: one-click https plus a mailto fallback for campaigns, Quick Send, automations and individual recruiter copies; BCC recruiter sends unsubscribe by email (`Unsubscribe rb-<token>` to the sending mailbox, read during ingest by `lib/email/unsubscribeByEmail.ts`) (`3b3933d`)

### Campaigns and data (2 Nov) ✅
- ✅ **RSVP buttons** in campaign and Quick Send emails, with seat limits, deadlines, answers written to a data column and a scanner-safe `/rsvp/<token>` page (`1c3ab61`)
- ✅ **"When someone replies"** branches per campaign: rules by reply type (AI now also recognises Interested / Not interested) (`4a58b5b`)
- ✅ Data grid up to 100,000 rows, virtualised (`f3313d7`)

### Recruiter Bulk Send (4–6 Nov) ✅
- ✅ BCC groups of up to 250 or individual copies, from chosen mailboxes (`90f4f09`); replies go to the sending admin's inbox, assigned to them, and Reply-To always includes the sending mailbox (`a6db99e`, `00791a6`)
- ✅ CC, live email preview, "Who receives this" plan, batches shown before sending and updated live, QA fixes (no double sends, live suppression) (`5bcf57d`, `166e4ba`, `9bb8cb6`, `724dd30`)
- ✅ Pasted or uploaded columns kept and choosable as the email column; `{{Column | fallback}}` personalisation including UTM links (variables need individual copies; empty values skipped) (`db387b3`)
- ✅ `sendOrder` PARALLEL (default: all mailboxes together, each with its own pause, `MAX_PARALLEL` 5, failover) or SEQUENTIAL; click a recruiter to see their email (`0f29a7f`)
- ✅ Can't stall: watchdog (`/api/cron/recruiter-watchdog`, called by the laptop only when the database shows a stuck send), awaited hand-over, no send started too close to the end of a run (`4000117`, `0cfceaa`)

### Reports (6–9 Nov) ✅
- ✅ **Daily report at 8 PM IST, Monday to Friday**, covering 8 PM to 8 PM; weekend work rolls into Monday's and after-hours work is marked; by type, user and mailbox, plus each person's inbox (received, pending, closed, FRT, ART) (`db387b3`, `f957766`)
- ✅ Recipients To / CC (`digest.to` / `digest.cc`, no Bcc); Slack Block Kit to its own channel (`digest.slackChannel`), posted as "MailFlow Daily Report"; email and Slack previews in System Settings (`71f09d8`)
- ✅ Weekly report (Monday 09:00 IST) in the same design, day by day, compared with last week (`71f09d8`)
- ✅ Sent by the 15-minute dispatch when due; the Vercel cron `daily-digest` (`0 15 * * 1-5`) is the backstop

### Analytics and admin (6–9 Nov) ✅
- ✅ Organization → **"Everything sent"**: every email (campaign, Quick Send, recruiter, inbox reply) by who launched it and which mailbox carried it, filters, CSV export (`lib/analytics/sendLedger.ts`, `28d03eb`)
- ✅ Product-wide audit (`fbdb742`): paging with real totals everywhere (`ListPager`, `useClientPaging`, `UrlListPager`, `lib/api/paging.ts`), honest errors with Try again (`LoadError`), IST date ranges (`lib/dates/istRange.ts`), no self-disable and the last Super Admin kept, signing send failures reported

### Look and feel (5–9 Nov) ✅
- ✅ New look: minimal light and glass dark themes, floating shell, animated dashboard (`8a057cc`, `5b52984`)
- ✅ **Profile photos** wherever a person is shown (People API `otherContacts`, scope `contacts.other.readonly`, plus Google profiles; initials as fallback; `Avatar`) and **contact names** from lists, replies and Google (`b4c8c81`, `3c897c6`, `b27cef5`, `6f37847`)
- ✅ Official Masai logo everywhere (`public/brand/`), round Masai "m" favicon (`51f8c6e`)
- ✅ Settings, System Settings and Mailbox usage redesigned to match the sidebar (`SettingsLayout`, `PageHeader`) (`cc5cb9a`)

## Replaced / removed

Kept here so older entries above still make sense.

| Was | Now | When |
| --- | --- | --- |
| **Neon Postgres** hosting | **Supabase Postgres** (Mumbai), plus Supabase Storage; Neon's free compute ran out on 19 Oct 2026 | 2 Nov 2026 (`8887bcb`) |
| **Vercel Blob** for signing attachments | Supabase Storage (`SUPABASE_URL` / `SUPABASE_SERVICE_KEY`); `BLOB_READ_WRITE_TOKEN` is only a legacy fallback in `app/api/e-sign/attachments/route.ts` | 2 Nov 2026 (`031c5df`) |
| **09:00 daily digest** (27 Sep automation pack) | **8 PM IST daily report**, Monday to Friday, email + Slack | 9 Nov 2026 (`f957766`) |
| Old weekly report layout | Weekly report in the daily report's design | 9 Nov 2026 (`71f09d8`) |
| Full **`googleapis`** package | `@googleapis/gmail`, `@googleapis/people`, `@googleapis/sheets` + `google-auth-library` | 6 Nov 2026 (`2683e8c`) |
| GitHub Actions calling send-queue, gmail-sync, follow-ups and Sheets sync every 15 minutes | One `/api/cron/dispatch` every 15 minutes; gmail-sync every 30 minutes; follow-ups and Sheets sync hourly | 6 Nov 2026 (`2683e8c`) |
| Laptop calling Vercel every 2 minutes for recruiter sends | Laptop checks the database and calls `/api/cron/recruiter-watchdog` only for a stuck send | 6 Nov 2026 (`2683e8c`) |
| BCC unsubscribe only through a "type your address" page | Unsubscribe by email to the sending mailbox; the page is the fallback | 9 Nov 2026 (`3b3933d`) |
| 5,000-row grid limit | 100,000 rows, virtualised | 2 Nov 2026 (`f3313d7`) |
| Node 24 on Vercel | Node 26.x pinned in `package.json` | 6 Nov 2026 (`8d54d8f`) |

## Open items

- ⬜ **Spam-complaint tracking** — Gmail doesn't report who marked mail as spam; Google Postmaster Tools (aggregate rates) and other providers' feedback loops (e.g. Yahoo CFL) are not wired in
- ⬜ **Gmail push live** — needs the Pub/Sub topic, push subscription and `GMAIL_PUBSUB_TOPIC`; until then replies arrive with the 30-minute sync
- ⬜ **Redis** — without it automation WAIT steps are skipped, scheduled replies go out at the 00:00 UTC cron, and the SCHEDULED automation trigger doesn't run
- ⬜ Attachment byte download for inbound mail (`attachments.get`)
- ⬜ Retention enforcement (deliberately deferred) and workspace create / rename / disable actions
- ⬜ Visual (drag-and-drop) template builder; per-org AI switch in the database; translate targets other than Hindi in the UI
- ⬜ Free-tier headroom to watch: Supabase 500 MB database / 1 GB storage / 5 GB egress a month; Vercel Hobby function and deployment limits

---

### Immediate next steps (in order)
1. ~~Connect a real Gmail account and verify the Google round-trip~~ — **done**: real send, real inbound sync (scan + history paths), real in-thread reply, all against the live mailbox.
2. ~~Phase 6: organization analytics, the "view as" banner, retention policy~~ — **done** (retention enforcement and workspace mutations deferred, see Phase 6).
3. ~~Phase 7: `AIProvider` + `GeminiProvider` with per-user/org rate limits; reply suggestion, summary, classification behind the header-first classifier~~ — **done**, verified against real Gemini.
4. ~~Close out Phase 1: saved views, filter/sort/group, bulk edit on the grid~~ — **done** (virtualization deferred to Phase 8).
5. ~~Scheduling dispatcher (Phase 3) and the `WAIT` action (Phase 4)~~ — **built** (15–16 Sep); both run on time only with Redis. The `SCHEDULED` trigger is still open.
