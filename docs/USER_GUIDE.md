# MailFlow — Team Guide

_Rollout: 7 September 2026 · Live at https://mailflow-six-sooty.vercel.app_

MailFlow is Masai School's internal tool for emailing students from your own Gmail: import a batch, write one template, preview it per student, get it approved, send it, and see every reply threaded back to the student it came from. Nothing goes out without a dry run and a human decision.

---

## 1. Day-one setup (do these in order)

1. **Sign in** at https://mailflow-six-sooty.vercel.app with your Google account ("Continue with Google").
2. **Connect Gmail**: Settings → Gmail → Connect. Approve the two permissions (send, read). Emails are sent **from your own address**; MailFlow never sends as anyone else. If Google shows "Gmail API has not been used", ask the super admin — it is enabled once for the project.
3. **Check your role** in Settings → Profile. Ask a super admin to change it if it is wrong (see §2).
4. **Pick a theme** (bottom of the sidebar): System, Light or Dark. It is remembered per browser.
5. **Send yourself a test** (Templates → any template → Send test email) to confirm the mailbox works before your first campaign.

## 2. Roles

| Role | Can do |
| --- | --- |
| **Viewer** | Read everything in their workspace. Cannot edit, send, or reply. |
| **Operator** | Import data, build templates and campaigns, run dry runs, submit for approval, send approved campaigns, reply in the Inbox, run automations. |
| **Admin** | Everything an Operator can, plus approve/reject campaigns in workspaces they belong to, and "Send without approval" for their own campaigns. Cannot approve their own campaign. |
| **Super Admin** | Everything, organisation-wide: Approvals for all workspaces, Users, Workspaces, All Data, All Conversations, Audit Logs, System Settings, Organization analytics, and "View workspace as" (read-only, audited). |

Every user has their own **workspace** — their datasets, templates, campaigns and inbox. Other people's workspaces are not visible unless a super admin opens them via View As.

## 3. The core workflow

### 3.1 Import data (Data)
- Data → **+ Dataset**, or **Import** → paste from Google Sheets/Excel, or upload CSV/XLSX.
- The preview detects headers and types and flags duplicate emails; choose Keep first / Keep latest / Import all.
- **Set the email column's type to EMAIL** (click the type under the column header). This is what makes the dataset sendable and links each row to a Contact.
- Importing never sends anything.

### 3.2 Work the grid
- Double-click a cell to edit; click a header to sort (click again for descending, again to clear); drag a header edge to resize; **Freeze first column** keeps names visible.
- **Filter** builds conditions (same language as automations: equals, contains, is empty…). System fields like *Email Status* and *Reply Received* are available too.
- **Group by** any column shows counts per value. **Search** matches every column.
- **Save view** keeps a filter + sort + grouping under a name for everyone using that dataset.
- **Bulk edit**: tick rows → *Set column… to value* → Apply. Every change is recorded per record, and automations that trigger on updates will evaluate — the confirmation says so.
- Columns panel: show/hide, rename, reorder, delete. Rows: ⧉ duplicates, ✕ deletes.

### 3.3 Write a template (Templates)
- Subject and body use variables from the dataset: `{{Name}}`, `{{Deadline}}` — insert them from the **+ Insert variable** menu so the spelling matches the column.
- **Preview as** a real student to see resolved values; unresolved variables are listed in yellow. Use the width slider or Desktop/Mobile to check layout.
- **AI assistant** (left panel): describe the email → Generate → Insert. Improve / Shorten / More professional / Fix grammar / Translate rewrite the current body. Subject ideas and Check personalisation are advisory. Nothing the AI writes is saved or sent until you click Insert and Save.
- **Format** pretty-prints the HTML (rendering is unchanged). **Run health check** before saving: it catches missing variables, a non-EMAIL recipient column, broken links, no connected mailbox.
- **Save new version**: every save is a new immutable version. Campaigns pin the version they were created with, so editing a template later never changes an email that already went out.

### 3.4 Build a campaign (Campaigns)
1. **+ Campaign**: name, dataset, template. The template version is pinned at this moment.
2. **Sender settings**: From name, Reply-To, CC/BCC (added to *every* email — for supervisors/archives, not per student). The From *address* is always your connected Gmail.
3. **Run simulation (dry run)**: shows exactly who would receive, who is skipped and why (invalid email, duplicate, automation stop condition). No email is sent.
4. **Review**: the exact headers and the rendered email per recipient. Read at least three.
5. **Submit for approval**. Approvers receive an email from your Gmail with you in CC. You cannot approve your own campaign.
6. After approval: **Send now**. Sending creates a **batch**.

### 3.5 Approve (Admins)
- **Approvals** in the sidebar (the badge is the pending count). Tabs: Pending / Approved / Rejected / All; search by campaign, requester or workspace.
- **Approve** (optional internal remarks) or **Reject** (a reason is required — the requester sees it). The decision is emailed back **in the same thread** as the request. If nobody has Gmail connected, the decision still happens and the row says why the email was skipped.
- The campaign page shows the same Approve/Reject buttons plus the full approval trail.

### 3.6 Watch the send (Batches)
- Batches shows every batch with live progress: sent / failed / skipped and how many are still queued. It refreshes itself while anything is running.
- **Process queue** pushes queued emails through now. **Pause / Resume / Cancel** are immediate. **Retry failed** re-queues only the failures.
- Emails go out at the configured rate (default 20 per minute per mailbox) — a 300-student batch takes about 15 minutes. Gmail also enforces its own daily sending limit on your account.

### 3.7 Replies (Inbox)
- Replies are synced from your Gmail into the Inbox, scoped to threads MailFlow started. Push delivery is not enabled yet: click **Sync now** (Inbox or Settings) to pull the latest.
- Bounces, out-of-office and auto-replies are classified automatically and never count as "the student replied".
- Open a conversation to: reply in the same thread, start a new thread, add an internal note, tag, assign, set a follow-up, change status. **AI suggest reply** drafts a reply you can Insert and edit; **Summarise** gives a summary and a suggested next action — you decide whether to apply it.
- Every conversation is linked to the Contact and the record it came from.

### 3.8 Contacts and History
- **Contacts** → a student's timeline: every email sent, every reply, notes, status changes, across datasets.
- **History** → the immutable log. *Sent*: every email with its outcome, reason and retries, and a "Why?" explanation. *Received*: every inbound message with its classification. Search and filter by status.

### 3.9 Dashboard
Live numbers for your workspace: emails sent, pending, failed, replies, unread, open conversations, follow-ups due; a 30-day send chart; the approvals chart; recent batches, conversations and activity; quick actions.

## 4. Automations
- Automations send a template when a record matches conditions (e.g. `Trigger = 1 AND Status is empty`) on record created/updated, with a frequency policy and cooldown so nobody is emailed twice by mistake.
- **Stop conditions** (e.g. *Reply Received = true*) are checked first and always win.
- **Enabling** an automation shows how many records it would affect *right now* and requires you to acknowledge that number. Run **Preview** first.
- Every run is listed with a result and a "Why?" explanation.

## 5. Super Admin tools
- **Users**: roles and enable/disable. Role changes are audited.
- **Workspaces**: every user's workspace with counts; **View Workspace** opens it read-only under a red "VIEWING WORKSPACE AS" banner (Exit View to leave). Entry and exit are audited. You cannot send from someone else's Gmail this way.
- **All Data / All Conversations**: organisation-wide lists with search and filters; every view is audited.
- **Organization**: users, workspaces, emails, replies, failure rate, campaign performance, approvals and user activity, 7/30/90 days.
- **Audit Logs**: who did what, when.
- **System Settings**: retention policy (configuration and impact preview only — nothing is deleted automatically), AI provider status, limits and usage, sign-in restriction.

## 6. Before you send — checklist
- [ ] Gmail connected and a **test email** received.
- [ ] Email column set to **EMAIL**; duplicates handled at import.
- [ ] Every `{{variable}}` resolves in **Preview as** for at least three students.
- [ ] **Health check** passes (warnings are fine, failures are not).
- [ ] **Dry run** count matches what you expect; skipped reasons make sense.
- [ ] From name, Reply-To and CC/BCC are right (CC/BCC go on *every* email).
- [ ] Reviewed the rendered email in **Review**.
- [ ] Submitted for approval; approver has read the Review page.
- [ ] After sending: watched the batch to completion in **Batches**; checked failures in **History**.

## 7. Things to know / current limits
- **Nothing is sent by AI, imports, or previews.** Only Send now, an approved campaign, a reply you click Send on, or an enabled automation sends email.
- **Gmail limits**: Google caps sends per account per day (typically 500 for @gmail.com, 2,000 for Workspace). MailFlow paces at 20/minute by default; failures show in History with the reason.
- **AI**: Gemini, 100 requests per person per day (1,000 per organisation). On the free tier the provider sometimes rate-limits; the panel then says "you can continue manually" and nothing breaks.
- **Replies**: pull-based for now — use **Sync now**. Attachments are listed but cannot be downloaded from MailFlow yet.
- **Grid**: datasets over 5,000 rows are filtered over the first 5,000 (the page says so).
- **Approval emails** need a connected Gmail on the requester (request) and on the reviewer or requester (decision).
- **Sign-in** is currently open to any Google account. Ask the super admin to restrict it to @masaischool.com when everyone is onboarded.

## 8. If something goes wrong
| Symptom | Do this |
| --- | --- |
| Sign-in fails | Try again; if "not permitted", your account was disabled — contact a super admin. |
| Gmail connect shows an error | Settings → Gmail → Connect again; make sure you are choosing your own Masai account. |
| Health check: "sender not connected" | Connect Gmail in Settings. |
| Campaign stuck in *Preparing* or *Queued* | Batches → **Process queue**. If it keeps failing, open History for the error. |
| No replies appearing | Inbox → **Sync now**. Replies are only pulled for threads MailFlow started. |
| AI buttons say "unavailable" or "limit reached" | Continue manually; try again later. Admins can see usage in System Settings. |
| Can't find Approve | Only Admins/Super Admins see **Approvals**; you cannot approve your own campaign. |

**Owner:** Abhishesh Kumar (abhishesh.kumar@masaischool.com). Bugs and requests: message with the page URL and what you expected.
