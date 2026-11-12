# MailFlow

Masai School's internal platform for talking to students and getting paperwork signed. One sign-in, two products:

| Product | What it's for |
| --- | --- |
| **MailFlow Mail** | Personalised email campaigns from your own Gmail, a shared inbox for replies, contacts and data, automations, dashboards |
| **MailFlow Sign** | Send agreements for e-signature: one at a time or in bulk from a CSV, with multiple signers, placed signatures and tracked reminders |

- **Live:** https://mailflowbymasai.vercel.app
- **Repo:** https://github.com/Sant1513/mailflow
- **Status (10 Nov 2026):** Phases 1–7, Sign (S1–S6), the Mail/Sign split, Quick Send, Recruiter Bulk Send, the Supabase move with the laptop server switch, the 8 PM daily report and the new look are all shipped. 68 unit-test files (`tests/`). See [Phase status](#phase-status).

Deeper docs: [ARCHITECTURE.md](ARCHITECTURE.md) (system design) · [PHASE_STATUS.md](PHASE_STATUS.md) (phase log, what was replaced, open items) · [docs/USER_GUIDE.md](docs/USER_GUIDE.md) (user guide) · [docs/team-guide.html](docs/team-guide.html) (team guide, also as `.docx` / `.pdf` in `docs/`) · [laptop-server/README.md](laptop-server/README.md).

## Contents

- [Two products, one sign-in](#two-products-one-sign-in)
- [MailFlow Mail](#mailflow-mail)
- [MailFlow Sign](#mailflow-sign)
- [Shared platform](#shared-platform)
- [Recruiter Bulk Send](#recruiter-bulk-send)
- [Where MailFlow runs](#where-mailflow-runs)
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
- **Inbox sharing** (Settings): share your inbox with everyone or chosen people, "can view" or "can view and reply" (replies go from your mailbox, in the same thread, audited). The Inbox has **My inbox / Shared with me**, and an assignee from another inbox can work a conversation assigned to them.
- Replies and scheduled replies refuse addresses that bounced or reported spam (`lib/email/replySuppression.ts`).
- **Profile photos and names** wherever a person is shown: photos from Google (People API, `contacts.other.readonly`) with initials as fallback; contact names filled from their lists, their replies and Google.
- **AI triage** of every human reply (switchable per organisation in Admin → System settings → Automation):
  - tags the conversation by intent (Question, Request, Complaint, Needs action, Completed, Thanks);
  - assigns unassigned conversations (an assignee per intent, or the mailbox owner), with the usual notification;
  - closes plain "thank you" replies when the AI is at least 85% sure and the team has already replied, leaving an internal note;
  - drafts an answer to questions and requests. The conversation shows **AI draft ready** with **Approve & send**, **Edit** and **Discard**, and the inbox shows a badge.

### Quick Send (one screen)
- **Mail → Quick Send** does a whole campaign on one page: a campaign name; recipients pasted (one email per line, "Name, email", or rows from Sheets/Excel), uploaded (CSV/XLSX), or picked from saved data or a segment; a subject and message with `{{fields}}` (or a saved template) and your signature; PDF attachments (up to 5, 10 MB per email); a live dry run and preview; **Send a test to me**; send now or later.
- Progress, opens, clicks, replies, failures and unsubscribes update live on the same page, with Pause/Resume and a list of recent Quick Sends.
- It creates a normal campaign underneath, so pacing, Google limits, backup mailboxes, tracking, unsubscribe and the Inbox all apply. Admins send at once; anyone else's goes to Approvals and sends automatically when approved (**Approve & send**).

### Campaigns
- Dataset-backed campaigns sent from the operator's own Gmail, with From name, Reply-To, CC and BCC. The sending address is always the connected mailbox.
- **Pre-send review** and a **dry run** that use the same evaluator as the real send, so "who gets what and why" is known before anything goes out.
- **Approval gate**: campaigns need an admin's sign-off, with request and decision emails in one thread and a full audit trail.
- **Scheduling** with a date-time picker, or send now.
- **Automatic sending at a safe pace**: once a campaign is sent, emails go out on their own, **3 seconds apart** and at most 20 a minute per mailbox, until the batch is done, even with the tab closed. Each email is claimed before it is sent, so nobody gets a duplicate; an email interrupted mid-send is checked against Gmail's Sent folder before it is retried.
- **Backup sender mailboxes**: a campaign can list up to 5 teammates' mailboxes, in order. When its own mailbox reaches the daily limit, is asked by Gmail to slow down, or is disconnected, the remaining emails go out from the first backup that can send (same 3-second pace and limits per mailbox), and switch back once the main mailbox can send again. Only mailboxes whose owners allowed it (Settings → Gmail → "Allow my mailbox as a backup sender") can be picked; backups can be added while a campaign is sending. Replies go to the backup mailbox and show on the campaign; each email records which mailbox sent it and why.
- **Within Google Workspace's sending limits**: each mailbox stops at 1,500 emails, 1,800 different recipients or 9,000 total recipients per rolling 24 hours (Google allows 2,000 messages, 2,000 unique external and 10,000 total recipients; 500 messages on trial accounts; a Cc on every email counts once as a different recipient) and carries on as the window frees up. If Gmail says "slow down" the mailbox pauses for 10 minutes, after a quota error for an hour, then resumes at the normal pace; Gmail's limit errors never mark the mailbox as disconnected. Every campaign email has a visible unsubscribe link and one-click `List-Unsubscribe` headers, as Google's sender guidelines ask.
- **Batches** with live progress, pause / resume / cancel, retry of failed sends (permanent failures are never retried), and duplicate protection enforced by a database constraint.
- **Personalised PDFs**: attach a per-recipient filled PDF to every email, built in the **PDF Library**.
- **RSVP buttons** (campaigns and Quick Send): 1–4 answers with seat limits, a deadline and an optional note; each recipient gets signed links kept out of click tracking; answers can be written to a data column. The campaign page shows counts, who answered what, and a CSV.
- **"When someone replies"** branches per campaign: ordered rules by reply type (including Interested / Not interested) that reply with a template, write a column, assign, tag, set status, stop follow-ups, unsubscribe or notify. First match wins (`lib/replyRules/`).
- Draft campaigns can swap dataset or template and re-sync to the latest template version.

### Tracking and deliverability
- Open pixel and click tracking on every campaign email. Links are signed together with their destination, so they can only redirect to the link that was in the email.
- Every link opens however it was written: pasted URLs become links, and addresses typed without `https://` (for example `levelupcareer.in`) are fixed.
- An **Unsubscribe button** on every bulk email (campaigns, Quick Send, automations, recruiter sends), with one-click `List-Unsubscribe` (https plus a mailto fallback). BCC recruiter sends unsubscribe by email (see [Recruiter Bulk Send](#recruiter-bulk-send)).
- A **suppression list** that blocks sends. Hard bounces from any tool or user are suppressed **org-wide** with the reason (`recordHardBounce`, plus `syncOrgBounces` in the daily-report cron to fill gaps).
- **Bot clicks filtered**: opens and clicks from link scanners, chat previews and scripts are kept but flagged automated and left out of every number.
- **Pre-send address checks** (review, dry run, send, Quick Send): unsubscribed or bounced before, domains with no mail server, typos of big providers, no-reply and throwaway addresses are skipped with the reason.
- **Mail → Deliverability**: bounce and unsubscribe rates against published thresholds (the bounce rate counts only the workspace's own campaign bounces), each mailbox's 24-hour usage, an SPF/DKIM/DMARC check and recent bounces.
- **Campaign analytics**: Overview / Sent / Read / Clicked / Replied / Failed tabs, KPI tiles, a per-day trend chart and per-tab email lists.

### Templates, data and contacts
- HTML/CSS template editor (CodeMirror) with a live preview, rendered with a real dataset record or contact.
- Every save is an immutable version, and campaigns pin the version they were created with.
- **Email health check** before sending: subject, variables, links, images, the plain-text part, and Gmail's ~102 KB clipping limit.
- XSS-safe preview (escaped values, sanitised HTML, sandboxed iframe).
- Airtable-style **Data** grid: import from paste, CSV or XLSX (with duplicate handling), inline edit, typed columns, saved views, filter / sort / group / search on the server, bulk edit and change history. Up to 100,000 rows per dataset, paged in the database (500 or 1,000 rows per page), and the grid draws only the visible rows.
- **Contacts** resolved from data automatically, contact **segments**, deduplication on import, and a per-contact timeline.
- **Google Sheets two-way sync** per dataset ("Google Sheet" on the dataset toolbar). Rows are matched by a key column such as email and sync every hour or on **Sync now**:
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
- **Daily report** by email (To/CC, no Bcc) and Slack (its own channel, posted as "MailFlow Daily Report"), 8 PM IST Monday to Friday: everything sent since the last report (8 PM to 8 PM; work after 8 PM goes into the next report and the weekend into Monday's, marked as such) by type, user and mailbox, each person's inbox (received, pending, closed, FRT, ART), and what needs attention. It replaced the old 09:00 digest.
- **Weekly report** (Monday 09:00 IST) in the same design: last week day by day, compared with the week before.
- Both are set up in **Admin → System Settings → Reports & triage** (sender mailbox, To/CC recipients, Slack channel), with an email and Slack preview and a test send.
- **Organization → Everything sent**: every email from every workspace (campaign and automation emails, Quick Send, recruiter sends, inbox replies) by who launched it and which mailbox carried it, with filters (including "sent from someone else's mailbox") and CSV export (`lib/analytics/sendLedger.ts`).
- **Mailbox usage** (admins): each mailbox's last 24 hours of campaign and recruiter sends against Google's limits.
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
- **Super Admin**: organisation analytics, users, workspaces, all data and conversations, **view workspace as** (read-only, audited), audit logs with filters, and **System Settings** (reports and AI triage, Slack, data retention, runtime configuration). You can't disable yourself, and the last Super Admin can't be removed.
- **Settings**: profile, Gmail connection, email signature, snippets, inbox sharing, SLA rules, server switch, **outbound webhooks** (HMAC-SHA256 signed; for conversation, bounce and unsubscribe events), and your Slack member ID. Settings and System Settings share one layout (`components/settings/SettingsLayout.tsx`): a sticky section menu in the sidebar's style, chips on phones.
- **Every list is paged** with real totals ("Showing x–y of N", jump to page, rows per page): `ListPager`, `useClientPaging`, `UrlListPager` and `lib/api/paging.ts`. Failed loads show the reason with **Try again** (`LoadError`). Date ranges are IST days (`lib/dates/istRange.ts`).
- Masai branding (`public/brand/`, round "m" favicon); minimal light and glass dark themes, responsive layout, installable PWA, keyboard shortcuts (`?` for help).

## Phase status

"Done" means a real database-backed API, a UI that calls it, server-side authorisation and, where practical, tests. Nothing is marked done on UI alone.

| Phase | Scope | Status | Shipped |
| --- | --- | --- | --- |
| 1 · Foundation | Google login, orgs/workspaces/RBAC, data grid, import, contacts, audit log | ✅ Done (grid virtualisation shipped 2 Nov) | 5–7 Sep |
| 2 · Templates | Versioned editor, variables, personalised preview, health check | ✅ Done (visual drag-and-drop builder open) | 5 Sep |
| 3 · Gmail + campaigns | Gmail OAuth, MIME/threading, review, dry run, approvals, batches, queue, scheduling | ✅ Done | 5–16 Sep |
| 4 · Automations | Conditions, stop rules, frequency, versioning, safety gate, WAIT | ✅ Done (WAIT and scheduled triggers need Redis) | 5–15 Sep |
| 5 · Inbox | Gmail sync, classification, conversations, replies | ✅ Done (Gmail push watch built 2 Nov, off until `GMAIL_PUBSUB_TOPIC` is set) | 5–10 Sep |
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
| Automation pack | Daily digest (since replaced by the 8 PM daily report), weekly report, send for signature from Data, signing write-back and presets, Google Sheets two-way sync, AI inbox triage, Word / Google Doc template import | ✅ Done | 27 Sep |
| Sending at scale | Automatic paced sending, Google Workspace limits, backup sender mailboxes, Quick Send | ✅ Done | 7–16 Oct |
| Hosting | Laptop server, Supabase move (Mumbai, `bom1`), one-server-at-a-time switch, file storage archived to the laptop | ✅ Done | 19 Oct – 2 Nov |
| Mail round 4 | Gmail push watch, RSVP buttons, reply branches, bot-click filtering, pre-send checks, Deliverability, inbox sharing, 100,000-row grid | ✅ Done | 2 Nov |
| Recruiter Bulk Send | BCC groups or individual copies, CC, columns and `{{Column}}` personalisation, parallel mailboxes, watchdog | ✅ Done | 4–6 Nov |
| New look + reports | Light / glass-dark themes, Masai branding, profile photos and names, Everything sent ledger, 8 PM daily and weekly reports with Slack, unsubscribe on every bulk email, paging audit, Settings redesign | ✅ Done | 5–9 Nov |
| 8 · Advanced analytics / integrations | Webhooks, SLA, performance, campaign analytics, Deliverability, grid virtualisation and Gmail push watch shipped; spam-complaint tracking open | 🟡 In progress | — |

## Release history

Most recent first. Full detail is in `git log`.

| Date | Release |
| --- | --- |
| 9 Nov | **Settings redesign** (`cc5cb9a`), **Masai logo** and favicon (`51f8c6e`), **Unsubscribe button on every bulk email** including BCC recruiter sends (`3b3933d`), product-wide **paging and error audit** (`fbdb742`), **weekly report** in the new design with its own Slack channel and preview (`71f09d8`), **8 PM daily report** Monday to Friday with org-wide bounces (`f957766`) |
| 6 Nov | **Stay inside Vercel Hobby**: small `@googleapis/*` packages, `ignoreCommand`, one 15-minute dispatch call (`2683e8c`, `a6b55a3`); Node pinned to 26.x (`8d54d8f`); recruiter sends from all mailboxes together (`0f29a7f`), list columns and `{{Column}}` personalisation (`db387b3`), watchdog (`4000117`); **Everything sent** ledger (`28d03eb`) |
| 5 Nov | **New look** with light and glass dark themes (`8a057cc`); profile photos (`b4c8c81`, `b27cef5`) and contact names (`6f37847`); org-wide hard-bounce suppression (`44863b3`); recruiter send CC, live preview and batches (`5bcf57d`, `166e4ba`) |
| 4 Nov | **Recruiter Bulk Send**: BCC groups of up to 250 or individual copies; replies reach the sending admin (`90f4f09`, `a6db99e`) |
| 2 Nov | **Supabase (Mumbai)** with functions in `bom1` (`8887bcb`), **server switch** cloud/laptop (`e1c7e9b`), Gmail push watch (`660a1b7`), RSVP buttons (`1c3ab61`), "When someone replies" (`4a58b5b`), bot-click filtering, pre-send checks and Deliverability (`89d73f8`), inbox sharing (`2efc830`), 100,000-row grid (`f3313d7`), file storage archived to the laptop (`031c5df`) |
| 19–27 Oct | **Laptop server** with Vercel as the front door, Tailscale Funnel repair (`276964d` … `e0259c2`) |
| 14 Oct | **Quick Send**: a whole campaign on one screen (`81bd589` … `9578736`) |
| 7–8 Oct | Automatic sending 3 s apart, Google Workspace limits, **backup sender mailboxes** (`b5d2855` … `a76d31a`) |
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

- **No Redis in production.** Campaign emails are sent by the database-backed background sender instead (see Campaigns), and **scheduled campaigns** start within about 15 minutes of their time. Automation **WAIT** steps are skipped, and **scheduled replies** are sent by the daily cron at 00:00 UTC (05:30 IST), not at the exact chosen time. Adding a Redis (for example Upstash's free tier) as `REDIS_URL` makes these run on time.
- **Files (signing attachments, signed PDFs)** go to Supabase Storage (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`, see `lib/storage/files.ts`); once a document is final, the laptop server archives the file and deletes the cloud copy, and archived files are served from the laptop (unavailable while it is off). Without the two settings, signed PDFs stay inline in the database and attachment uploads are refused with a message.
- **Vercel Hobby crons run once a day.** GitHub Actions calls the cheap `/api/cron/dispatch` every 15 minutes (it starts the senders only when something is waiting and sends the daily report when it is due), Gmail sync every 30 minutes, and follow-ups and Sheets sync hourly; the other jobs run daily (see [Scheduled jobs](#scheduled-jobs)).
- **Gmail push** (`lib/gmail/watch.ts`) starts and renews each mailbox's watch once `GMAIL_PUBSUB_TOPIC` is set and the Pub/Sub topic and push subscription exist; until then replies arrive with the 30-minute sync (and auto-sync when the Inbox is opened).
- **Spam complaints are not tracked.** Gmail doesn't tell senders who marked a message as spam; only aggregate rates (Google Postmaster Tools) or feedback loops from other providers (for example Yahoo's) exist, and neither is wired in. Unsubscribes and bounces are tracked.
- Not built yet: attachment byte download for inbound mail, retention enforcement (deliberately deferred), workspace create/rename/disable actions, a visual template builder, and a per-org AI switch.
- The start-product choice is saved per browser, so each new device shows the chooser once.
- **Google Sheets sync** needs the Google Sheets API enabled in the Google Cloud project and the `spreadsheets` scope on the OAuth consent screen. Unless the consent screen is Internal, Google shows an "unverified app" warning for that scope. Sync handles up to 5,000 rows per sheet; if two people edit the same cell in both places between syncs, the MailFlow edit wins.
- Google Doc import only works for docs shared "Anyone with the link can view" (otherwise download as .docx and upload). Imported documents show the header once at the top rather than on every page, floating objects are placed approximately, and EMF/WMF images (old Word charts) are left out with a warning.

## Tech stack

| Layer | Choice |
| --- | --- |
| App | Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS |
| Auth | NextAuth (Google OAuth, database sessions) |
| Database | PostgreSQL on Supabase (free plan, Mumbai), Prisma ORM with versioned migrations. A full standby copy lives on the laptop server (see [Where MailFlow runs](#where-mailflow-runs)) |
| Email | Gmail API from each user's own mailbox (OAuth tokens AES-256-GCM encrypted at rest), via the small `@googleapis/gmail`, `@googleapis/people` and `@googleapis/sheets` packages plus `google-auth-library` (`googleapis-common` pinned to 9.0.0 in `overrides`) |
| Queue | BullMQ + Redis when available, otherwise bounded drain endpoints and crons |
| PDFs | Headless Chromium (`puppeteer-core` + `@sparticuz/chromium`) for signing PDFs, `pdf-lib` for overlays, certificates and personalised campaign PDFs, `pdfjs-dist` for page previews |
| Files | Supabase Storage (signing attachments, signed PDFs, recruiter videos); final signing files archived to the laptop (`lib/storage/files.ts`) |
| AI | Google Gemini via a provider abstraction |
| Hosting | Vercel (Hobby, Node 26.x, functions in Mumbai `bom1`), GitHub Actions for 15/30/60-minute schedules; the laptop server as standby or active server |

## Recruiter Bulk Send

**Mail → Recruiter Bulk Send** (admins) sends one email to many recruiters, separately from campaigns (`lib/recruiterSend/`, tables `RecruiterBlast*`).

- **Two ways out**, chosen per send:
  - **BCC groups**: up to 250 recruiters in Bcc per email, with a fixed visible To address. Opens are counted per group, because every recipient loads the same image.
  - **Individual copies**: each recruiter gets their own email, and opens are known per recruiter.
- **Opens only.** Links are never rewritten. Scanner and prefetch opens don't count.
- **Recruiters.** Paste, upload a CSV/Excel file, or use saved data. All columns are kept, and you choose which one holds the email. The same pre-send address checks as campaigns apply: unsubscribed, bounced, dead domains, typos, no-reply and throwaway addresses are skipped, with the reason shown in **Who receives this**.
- **The email.** Subject, a simple or HTML body, signature, From name, CC, Reply-To, and PDFs from the PDF Library, with a live preview. `{{Column}}` or `{{Column | fallback}}` personalises the subject, body and links (UTM links too); variables need individual copies, and an empty value is skipped rather than left as a blank.
- **Replies.** Reply-To always includes the sending mailbox, so replies are tracked and land in the sending admin's inbox, assigned to them.
- **Video.**
  - Attached (≤ 20 MB): uploaded straight to Supabase Storage. Large messages go through Gmail's upload endpoint.
  - As a "Watch the video" link: Drive or YouTube, any size.
- **Mailboxes.** The admin's own plus teammates' opted-in backup mailboxes. Each can have a **limit for the send**. **All mailboxes together** (default, `sendOrder` PARALLEL): mailboxes take turns, each with its own pause, up to 5 messages out at once (`MAX_PARALLEL`), and a mailbox that reaches its limit, Google's daily limits (shared with campaigns in `usageLast24h`) or a Gmail pause hands its share to the others. **One mailbox after another** (SEQUENTIAL) uses them in the chosen order.
- **Pacing and control.** A pause between emails, test send, schedule, the batches shown before sending and updated live, pause/resume/cancel, click a recruiter to see the exact email they got, and **Copy** for a new draft with the same recruiters, email and mailboxes.
- **Unsubscribe.** Every email has an Unsubscribe button. For BCC groups it writes an email (`Unsubscribe rb-<token>`) to the sending mailbox, which the inbox sync reads to suppress exactly that sender (`lib/email/unsubscribeByEmail.ts`); the page where the recruiter types their address is the fallback, and only addresses on that send are accepted. Individual copies use the normal one-click link.
- **Sender.** `/api/cron/recruiter-send` restarts itself while work remains. The 15-minute `/api/cron/dispatch` starts it when work is waiting, and `/api/cron/recruiter-watchdog` (called by the laptop server only when the database shows a stuck send) restarts a stalled one. Sends count against the same per-mailbox limits shown on **Mailbox usage**.
- **Send from the laptop.** Step 7 offers *Send from: Cloud (default) / This laptop*. A laptop send (`RecruiterBlast.runOn = 'laptop'`) is sent by the laptop server's standby runner (`laptop-server/recruiter-runner.ts`) on the cloud database with the same sender code, so it costs no Vercel CPU; Vercel's runs skip it. Offered only while the laptop is online (`GET /api/recruiter-blasts/laptop-status`); if the laptop goes silent for 10 minutes the cloud carries on by itself (`runOnChangedAt`, "Moved to the cloud — the laptop went offline"). No server switch, no copy. Details: [laptop-server/README.md](laptop-server/README.md#send-from-the-laptop-recruiter-bulk-send-standby).

## Where MailFlow runs

MailFlow runs on **one server at a time**, chosen on **Settings → Server** (super admins):

- **Cloud** (normal): Vercel + Supabase. Fast and reachable from anywhere.
- **Laptop**: the laptop server in `laptop-server/` (Postgres + the app + every scheduled job), published through Tailscale Funnel; Vercel forwards the public address to it (`middleware.ts`).

The other one is a standby copy. Switching shows everyone a short "switching servers" page while the laptop copies the active database across in one checked transaction (`laptop-server/copy-db.mjs`), then flips the switch — sessions are copied too, so nobody is signed out. Only one side ever writes. The switch itself is one row (`SystemState`) in the cloud database that copies never touch; the rules are in `lib/system/serverState.ts`. Safety moves: a switch the laptop doesn't finish within 5 minutes is cancelled; an active laptop that is silent for 10 minutes hands over to the cloud; the laptop hands back by itself if its public address is unreachable for 10 minutes. On standby the laptop pulls a full copy of the cloud every night; while active it pushes one every 30 minutes. Setup and operation: [laptop-server/README.md](laptop-server/README.md).

Background: Neon's free plan ran out of compute in October 2026 (it was shared with two other apps), so MailFlow moved to Supabase, whose free plan has no compute-hour limit. Keep it within the free plan: 500 MB database, 1 GB file storage, 5 GB/month data transfer — count in SQL rather than loading rows, and don't poll from hidden tabs.

## Local setup

```bash
npm install
cp .env.example .env    # fill in the values below
npm run dev             # http://localhost:3000 (pinned: the OAuth redirect URIs are port-specific)
```

> ⚠️ **Check which database `.env` points at before running any Prisma command.** If `DATABASE_URL` is the production database (Supabase) or the laptop server's, `npm run db:migrate` (`prisma migrate dev`) would change it. New migrations should be written as SQL files in `prisma/migrations/` and are applied by the production build (`prisma migrate deploy`).

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
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | — | Supabase Storage for signing attachments, signed PDFs and recruiter videos. Without them signed PDFs stay inline in the database and uploads are refused (`BLOB_READ_WRITE_TOKEN`, the old Vercel Blob, is only a legacy fallback for signing attachments) |
| `SLACK_BOT_TOKEN` | — | Slack notifications and the daily/weekly report posts (channels set in System Settings) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS` | — | AI assistant (the app runs without it) |
| `NEXT_PUBLIC_APP_URL` / `APP_URL` | — | Public base URL if it differs from `NEXTAUTH_URL` (`lib/app-url.ts`) |
| `CONTROL_DATABASE_URL`, `INTERNAL_APP_URL`, `ARCHIVE_DIR` | laptop only | Set by the laptop server: the cloud database that holds the server switch, the app's own address for sender hand-overs, and the folder of archived files |
| `AI_ENABLED`, `AI_USER_DAILY_LIMIT`, `AI_ORG_DAILY_LIMIT` | — | AI switch and daily limits (defaults 100 per user, 1000 per org) |
| `EMAIL_RATE_LIMIT_PER_MINUTE`, `EMAIL_SEND_GAP_MS`, `EMAIL_DAILY_LIMIT`, `EMAIL_MAX_ATTEMPTS` | — | Send pacing (default 20 a minute, 3000 ms between emails, 1,500 emails a day per mailbox, max 1,900; set 500 for trial Workspace accounts) and retry limit |
| `GMAIL_PUBSUB_TOPIC` / `GMAIL_PUBSUB_VERIFICATION_TOKEN` | — | Gmail push notifications (Sync Now and auto-sync work without them) |
| `CHROME_PATH` | — | Local Chrome/Edge for signing PDFs (auto-detected on Windows, macOS and Linux) |
| `SIGNING_PDF_RENDERER` | — | `pdf-lib` forces the built-in renderer; `browser` forces Chrome |

Set production variables at the project level (`vercel env add NAME production`), not per deploy.

## Scheduled jobs

GitHub Actions (`.github/workflows/follow-up-reminders.yml`, workflow `scheduled-jobs`) fires every 15 minutes; Vercel Hobby crons (`vercel.json`) are daily backstops. While the laptop server is active it runs every job itself.

| Job | Vercel cron (UTC) | GitHub Actions |
| --- | --- | --- |
| `/api/cron/dispatch`: starts the campaign and recruiter senders only when something is waiting, and sends the 8 PM daily report once it is due | — | every 15 min |
| `/api/cron/send-queue`: send queued campaign emails (also started by every send and by dispatch, and continues itself until done) | 03:45 daily | via dispatch |
| `/api/cron/recruiter-send`: send Recruiter Bulk Send messages (continues itself until done) | — | via dispatch |
| `/api/cron/recruiter-watchdog`: restart a stalled recruiter send | — | called by the laptop server only when the database shows a stuck send |
| `/api/cron/gmail-sync`: sync every connected mailbox (and renew Gmail push watches) | 03:00 daily | every 30 min |
| `/api/cron/follow-ups`: follow-up reminders (app + Slack) | 03:30 daily | hourly |
| `/api/cron/scheduled-send`: dispatch scheduled campaigns | 00:00 daily | — |
| `/api/cron/scheduled-replies`: send scheduled replies | 00:00 daily | — |
| `/api/cron/sla-check`: flag SLA breaches | 08:00 daily | — |
| `/api/cron/signing-reminders`: remind unsigned signers, expire overdue links, refresh "Days waiting to sign" on rows | 09:00 daily | — |
| `/api/cron/daily-digest`: backstop for the 8 PM daily report (email + Slack; sends only if dispatch hasn't); also fills org-wide bounce gaps (`syncOrgBounces`) | 15:00 Mon–Fri (8:30 PM IST) | — |
| `/api/cron/weekly-report`: weekly report (09:00 IST) | 03:30 Mondays | — |
| `/api/cron/housekeeping`: delete old notifications (90 days), audit entries (365 days), finished webhook deliveries (30 days) and expired sessions; free-tier size warning (DB 350 MB, storage 700 MB) | 20:30 daily (2 AM IST) | — |
| `/api/cron/sheets-sync`: two-way Google Sheets sync | 03:15 daily | hourly |

## Testing

```bash
npm test                 # unit tests (no database needed)
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
| `smoke-test-send-pacing.ts` | 3-second spacing, no duplicate sends with two senders at once, pause, daily cap, Gmail back-off (fake provider) |
| `smoke-test-send.ts` · `smoke-test-automation.ts` | Send pipeline and automation engine against the live database |
| `smoke-test-inbox.ts` · `smoke-test-inbox-http.ts` · `smoke-test-inbox-notify-http.ts` | Gmail ingestion, conversations, composer, notifications |
| `smoke-test-approvals-http.ts` · `smoke-test-admin-http.ts` · `smoke-test-grid-http.ts` · `smoke-test-pages-http.ts` | Approvals, super admin, data grid, page sweep |
| `smoke-test-documents.ts` · `smoke-test-ai.ts` · `smoke-test-db.ts` | Personalised PDFs, Gemini, database checks |

## Deployment

- Every push to `master` deploys to production on Vercel.
- The build (`scripts/build.mjs`) runs `prisma migrate deploy && prisma generate && next build`, so **pending migrations are applied to the production database (Supabase) on deploy**; the laptop server applies them to its own database when it starts. Review migration SQL before pushing.
- **Builds are skipped** when a push only changes tests, `laptop-server/`, `.github/`, docs or `*.md` (`vercel.json` → `ignoreCommand: sh scripts/vercel-ignore.sh`, which only ever exits 0 = skip or 1 = build). This keeps Vercel Hobby's deployment storage down.
- The laptop server runs its own copy of the code (`C:\Users\abhis\mailflow-live`, a git worktree): after pushing, `git checkout --detach master` there and create `mailflow-data\restart.request` — it rebuilds itself on the next start.
- Node is pinned to **26.x** (`package.json` → `engines`, matching the Vercel project setting). Signing-PDF routes bundle the Chromium binary (`next.config.mjs` → `outputFileTracingIncludes`) and allow up to 60 s for a cold start.
- Stay inside the free plans: Vercel Hobby (no extra crons, small functions, few builds) and Supabase free (500 MB database, 1 GB storage, 5 GB/month egress).
- After deploying, run `scripts/verify-deployment.ts`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run build` / `start` | Production build (`scripts/build.mjs`, with migrations) / run |
| `npm run verify` | Typecheck + lint + tests + isolated build |
| `npm run build:isolated` | Production build into `.next-verify`, leaving a running dev server's `.next` alone |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm test` | Vitest unit tests |
| `npm run db:migrate:deploy` | Apply pending migrations |
| `npm run db:studio` | Browse the database |
| `npm run db:seed` | Seed an org and a sample dataset |
| `npm run worker:email` · `worker:automation` | Queue workers (need Redis) |
