# Build request — approvals workflow, themes, responsive UI, template editor fixes

_Captured 7 Sep 2026 from product feedback. This is the prompt the implementation is built against; each numbered block is one deliverable with its acceptance checks._

## 1. Campaign approval workflow (admin side)

**Problem.** A campaign can be submitted for approval, but an admin has nowhere to find and act on those requests, and nobody is notified.

**Build.**
- An **Approvals** page (`/approvals`) in the sidebar for SUPER_ADMIN and ADMIN, listing every campaign awaiting approval in their scope (SUPER_ADMIN: whole organisation; ADMIN: their workspace). Columns: campaign, requester, workspace, dataset and recipient count, template + version, submitted at, waiting time. **Search** by campaign name / requester / workspace. Tabs for **Pending / Approved / Rejected / All** so the history is visible.
- **Approve** and **Reject** from the list and from the campaign page. Reject requires a **reason** (sent to the requester); both accept optional **remarks** (internal). An admin still cannot approve their own campaign.
- **Email on request.** When a campaign is submitted, send an email from the requester's connected Gmail to every SUPER_ADMIN (and workspace ADMINs) with the requester in **CC**. Body: campaign, recipient count, subject line, a link to the review page. Store the message id and thread id on the campaign.
- **Email on decision.** When approved or rejected, send the confirmation **in the same email thread** (In-Reply-To / References = the request message; same Gmail thread id when sent from the same mailbox) to the requester, with the decision, reason and reviewer. Prefer the approver's connected mailbox; fall back to the requester's own mailbox so the thread is always continued. If no mailbox is connected, the decision still happens and the page says the email could not be sent — never block the approval on email.
- **Reports.** Approvals in the analytics: counts (pending / approved / rejected, median wait) and a **chart of requests, approvals and rejections by day** on the Organization page and a workspace-scoped version on the Dashboard.
- Everything audited (`CAMPAIGN_SUBMIT`, `CAMPAIGN_APPROVE`, `CAMPAIGN_REJECT`, plus the notification emails).

**Accept when:** submitting a campaign produces the request email with admins in To and requester in CC; approving from `/approvals` produces a reply in that thread; the requester sees the decision, reason and remarks on the campaign page; the dashboard chart shows the day's counts; a viewer/operator gets 403 on the approvals API.

## 2. Light and dark theme

- A theme toggle in the sidebar (and login page) with three states: **System / Light / Dark**. Persist in `localStorage`, default to the OS preference, apply before first paint (no flash).
- The Masai palette stays the brand in both: red accent, Outfit headings. Light theme = white/near-white surfaces with the same token names, so every component works unchanged.
- Charts, badges, form controls, code editor and the email preview frame follow the theme.

**Accept when:** every page renders correctly in both themes with no hard-coded dark colours; the choice survives reload; the OS preference is respected when set to System.

## 3. Responsive / UI polish

- The sidebar becomes a **top bar with a menu button below 1024px**, opening a drawer; content gets the full width.
- Pages that use fixed side panels (conversation, template editor, dataset grid) stack or become tabs on small screens; no horizontal page scroll except inside the grid.
- Fix overlaps: popovers (AI "Why?" panels) must not spill off-screen; toolbars wrap; long titles truncate; tables scroll inside their container.
- Touch targets ≥ 36px on mobile; the dashboard, inbox, conversation, campaign monitor, record detail and history are usable at 375px (§133).

**Accept when:** a 375px viewport shows no overlapping elements on the login, dashboard, inbox, conversation, campaign, template and data pages, and the desktop layout is unchanged.

## 4. Template code formatting

**Problem.** AI-generated HTML is inserted as a single line, so the editor is unusable for manual edits.

- Pretty-print HTML (indent block-level tags, one element per line, keep inline text intact) whenever AI output is inserted or applied, and offer a **Format** button in the editor for any template.
- Never change rendered output: formatting only adds whitespace between block elements.

**Accept when:** inserting an AI email yields multi-line, indented HTML; formatting a template does not change its preview; a unit test covers nesting, inline tags, `<pre>`, comments and attributes with `>` in them.

## 5. Template editor pane sizing

- Draggable dividers between **Settings | Code | Preview**, with sensible min widths; the split is remembered per browser.
- A **preview width slider** (320–1200px) in addition to the desktop/mobile presets, so any client width can be checked.

**Accept when:** the three panes can be resized by dragging and the sizes persist across reloads; the preview slider changes the rendered frame width live.

---

### Assumptions
- Approval emails go through the same `EmailProvider` as campaigns (no separate SMTP), so they need a connected Gmail; that is already required to send campaigns.
- "Admin side" means both SUPER_ADMIN and workspace ADMIN reviewers; the org-wide list is SUPER_ADMIN-only.
- Rejection reason is shown to the requester; remarks are internal to reviewers.
- Theme preference is per browser (not stored on the user), matching how most tools do it and avoiding a schema change.
