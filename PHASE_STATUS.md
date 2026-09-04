# Phase status

## Deployment

- **Live:** https://mailflow-six-sooty.vercel.app (Vercel, production)
- **Database:** Neon Postgres (schema migrated, `prisma/migrations/`)
- **Repo:** https://github.com/Sant1513/mailflow

## Verification status (last run: 4 Sep 2026, after Phase 4)

| Suite | Count | Result |
| --- | --- | --- |
| Unit tests (`npm test`) | 205 | ✅ pass |
| Live-DB integration (`scripts/smoke-test-db.ts`) | 19 | ✅ pass |
| Send pipeline, live DB + fake provider (`scripts/smoke-test-send.ts`) | 35 | ✅ pass |
| Automation engine, live DB (`scripts/smoke-test-automation.ts`) | 28 | ✅ pass |
| HTTP integration (`scripts/smoke-test-http.ts`) | 37 | ✅ pass |
| Deployment verification (`scripts/verify-deployment.ts`) | 19 | ✅ pass |
| `tsc --noEmit` / ESLint / `next build` | — | ✅ clean |

Google OAuth is configured and verified as far as it can be without a real
account: the authorization request is accepted by Google (correct client_id,
registered redirect URI, PKCE). The final "click through Google's consent
screen with a real @masaischool.com account" step needs a human with such an
account — it is **not** yet confirmed end-to-end.


Honest, current status of the spec's §138 phases. "Done" means: real DB-backed
API route + UI calling it + server-side authorization + (where practical) a
test. Nothing is marked done on UI alone (§139/§140).

## Phase 1 — Foundation ✅ mostly done
- [x] Google OAuth login restricted to `@masaischool.com` (`lib/auth/options.ts`)
- [x] Organization / Workspace / User / WorkspaceMember schema, RBAC roles
- [x] Role enforcement in `lib/auth/session.ts` (`requireSession`, `requireRole`) — server-side, not just hidden nav
- [x] Super Admin cross-workspace read path (`lib/permissions/workspace.ts`) + audit on admin view
- [x] Postgres schema for the full domain model (`prisma/schema.prisma`)
- [x] Airtable-style data table: inline edit, add/delete row, add column (`components/data-grid/DataGrid.tsx`)
- [x] Paste / CSV / XLSX import with preview → type inference → duplicate handling → commit (`lib/imports/parse.ts`, `/api/datasets/import*`) — **import never sends email**
- [x] Contacts as a first-class entity, resolved by email at import/edit time (`lib/records/contactLink.ts`)
- [x] Record change history on manual edits (`RecordChangeHistory`)
- [x] Audit logging framework (`lib/audit/log.ts`) wired into every mutation so far
- [x] Admin: Users (role/status management), Audit Logs, Organization stats, Workspaces list, All Data — real queries
- [x] Deployed to Vercel against a live Neon Postgres, with integration tests run against the deployed instance
- [ ] Column reorder/resize/hide UI, saved views, filter/sort/group UI, bulk select/update, freeze columns, virtualization — grid backend (hidden/order/width columns) exists in schema; UI controls not built yet
- [ ] "View as" banner + Exit View UX (server-side access + audit already enforced)

## Phase 2 — Templates ✅ mostly done
- [x] Template CRUD + duplicate + archive (`/api/templates*`), workspace-scoped and RBAC-enforced
- [x] Delete is refused when a campaign references the template — it archives instead, so historical campaigns keep their content (§21/§126)
- [x] **Versioning**: every save creates a new immutable `TemplateVersion`; identical content is a no-op instead of inflating version numbers; old versions are never mutated
- [x] Three-pane editor (settings / HTML+CSS code editor / live preview) with CodeMirror
- [x] **Variables** (`{{Name}}`): extraction, `+ Insert variable` menu populated from the dataset's real columns, resolved-value panel
- [x] **Personalized preview** — "Preview as \<record\>" renders against a real dataset record; desktop/mobile widths
- [x] **XSS-safe preview**: values are HTML-escaped on substitution, template HTML is sanitized server-side, and the result renders in an iframe with an empty `sandbox` (no scripts) — 12 attack vectors covered by tests
- [x] **Email health check** (§27): subject, body, variable validity against the dataset, recipient column, sender connection, brace typos, links, images, plain-text alternative, Gmail's ~102KB clipping threshold. Fails block; warnings don't.
- [x] Plain-text alternative auto-generated from HTML when not supplied
- [ ] **Send test email** — deliberately deferred: it needs a connected Gmail account, which is Phase 3. The health check already reports "Sender connected: fail" until then, rather than offering a button that can't work.
- [ ] Rich-text (WYSIWYG) editing mode — HTML/CSS editing works; a visual drag-and-drop builder is a later refinement.

## Phase 3 — Gmail + Campaigns + Queue ✅ mostly done
- [x] Gmail OAuth as a **separate** consent step from login; CSRF-protected callback, scope verification, and a refusal to connect a mailbox that isn't the signed-in user's own
- [x] Tokens AES-256-GCM encrypted at rest, auto-refreshed, never sent to the browser
- [x] `EmailProvider` abstraction + `GmailProvider`; nothing outside `lib/email/*` and `lib/gmail/*` touches the Gmail SDK
- [x] RFC 2822 MIME builder: multipart/alternative, attachments, RFC 2047 headers, and **In-Reply-To / References threading** (§46) — plus CRLF stripping so a template variable can't inject headers
- [x] Campaign CRUD, with the template version **pinned at creation** (§21/§126)
- [x] **Dry run** sharing one pure evaluator with the real send, so the simulation genuinely predicts the send; every record gets a reason
- [x] "Why was this sent" recorded on every job; never blank (§35)
- [x] Approval workflow — server-enforced: only ADMIN/SUPER_ADMIN approve, nobody approves their own campaign
- [x] Batches + one immutable `EmailJob` snapshot per recipient (rendered body + sender identity)
- [x] Duplicate protection enforced by a **DB unique constraint** on (campaign, record, templateVersion), not just app logic
- [x] Pause / resume / cancel, re-checked immediately before each send
- [x] Retry that classifies failures — permanent ones (invalid recipient, revoked auth) are never retried
- [x] Rate limiting from durable rows, so the cap survives restarts
- [x] BullMQ + Redis worker (`npm run worker:email`) **and** a bounded drain endpoint for deployments without Redis — both call the same `processEmailJob`
- [x] Test email (§26) — exactly one message, clearly marked, never to campaign recipients
- [ ] Scheduling: `scheduledAt` is stored and shown, but no scheduler process dispatches it yet — a scheduled campaign still needs Send pressed
- [ ] CC/BCC and attachments on campaigns (the MIME builder supports both; the campaign UI does not expose them yet)

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

## Phase 5 — Threading / inbound sync / Inbox — not started
Schema exists (`Conversation`, `ConversationMessage`, `InternalNote`, `Tag`,
`FollowUp`, `RecipientHistory`). No Pub/Sub webhook, no sync worker, no Inbox
UI (shows an honest "not yet implemented" panel today).

## Phase 6 — Super Admin analytics/org management — partially started
Users, Workspaces, Organization overview, Audit Logs, All Data are real
today. Charts, retention policy config, and the "view as" banner are not.

## Phase 7 — Gemini AI — not started
`AiUsage` table exists. No `AIProvider`/`GeminiProvider` implementation yet.

## Phase 8 — Advanced analytics / integrations — not started

---

### Immediate next steps (in order)
1. **Gmail OAuth connect + `EmailProvider`/`GmailProvider` abstraction** (Phase 3) — the single biggest unlock: it turns on test-sends, campaigns, and everything downstream.
2. Campaign model + dry run + approval + batches + BullMQ `email-send` worker (rest of Phase 3).
3. Saved views + filter/sort/bulk-edit UI on the data grid (closes out Phase 1).
4. Automation builder (Phase 4).
