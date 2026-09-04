# Phase status

## Deployment

- **Live:** https://mailflow-six-sooty.vercel.app (Vercel, production)
- **Database:** Neon Postgres (schema migrated, `prisma/migrations/`)
- **Repo:** https://github.com/Sant1513/mailflow

## Verification status (last run: 4 Sep 2026, after Phase 2)

| Suite | Count | Result |
| --- | --- | --- |
| Unit tests (`npm test`) | 87 | ✅ pass |
| Live-DB integration (`scripts/smoke-test-db.ts`) | 19 | ✅ pass |
| HTTP integration, localhost (`scripts/smoke-test-http.ts`) | 37 | ✅ pass |
| HTTP integration, live production | 37 | ✅ pass |
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

## Phase 3 — Gmail + Campaigns + Queue — not started
Schema exists (`EmailProviderAccount`, `Campaign`, `Batch`, `EmailJob`,
`lib/crypto/secretBox.ts` for token encryption). No Gmail OAuth connect flow,
no send pipeline, no BullMQ workers yet. `npm run worker:*` scripts are
placeholders for when this phase lands — the worker files don't exist yet on
purpose (no fake queue processing).

## Phase 4 — Automation builder — not started
Schema exists (`Automation`, `AutomationVersion`, `AutomationRun`). No
condition-tree UI, no evaluator, no run log UI.

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
