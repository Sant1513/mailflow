# Phase status

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
- [ ] Column reorder/resize/hide UI, saved views, filter/sort/group UI, bulk select/update, freeze columns, virtualization — grid backend (hidden/order/width columns) exists in schema; UI controls not built yet
- [ ] "View as" banner + Exit View UX (server-side access + audit already enforced)

## Phase 2 — Templates — not started
Schema exists (`Template`, `TemplateVersion`). No builder UI, no HTML/CSS
editor, no variable validation, no test-send, no health check yet.

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
1. `npm install`, provision Postgres + Redis, `npm run db:migrate`, sign in once, `npm run db:seed`.
2. Saved views + filter/sort UI on the data grid (closes out Phase 1).
3. Template builder (Phase 2) — this unblocks Campaigns, which is the biggest single remaining phase.
4. Gmail OAuth connect + `EmailProvider`/`GmailProvider` abstraction + BullMQ `email-send` worker (Phase 3).
