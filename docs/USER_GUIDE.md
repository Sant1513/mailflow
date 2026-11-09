# MailFlow — Team Guide

_Updated 10 November 2026 · Live at https://mailflow-six-sooty.vercel.app · Styled version: [team-guide.html](team-guide.html) (also as [PDF](MailFlow-Team-Guide.pdf) and [Word](MailFlow-Team-Guide.docx))_

MailFlow is Masai's internal tool for emailing students and recruiters from your own Gmail, and for collecting e-signatures. Import a list, write one email, check it per person, send it, and see every reply threaded back to the person it came from. Every bulk email carries an Unsubscribe button.

---

## 1. Day-one setup (do these in order)

1. **Sign in** at https://mailflow-six-sooty.vercel.app with "Continue with Google". The first time, your account waits until a Super Admin approves it (Approvals → User Registrations).
2. **Connect Gmail**: Settings → Gmail → Connect, and approve the permissions. Emails are sent **from your own address**; MailFlow never sends as anyone else.
3. **Add your email signature** in Settings → Email signature. Quick Send and Recruiter Bulk Send can add it for you.
4. **Optional, in Settings → Gmail**:
   - **Allow my mailbox as a backup sender.** Teammates can then use your mailbox when theirs hits Google's daily limit, is slowed down or is disconnected. Replies still go to them.
   - **Profile photos** for your contacts. This gives read-only access to your Google contacts.
5. **Check your role** in Settings → Profile. Ask a Super Admin if it is wrong.
6. **Send yourself a test**. Use Templates → any template → Send test email, or "Send a test to me" in Recruiter Bulk Send.

**Find anything fast:**
- **Ctrl K** opens the command menu.
- **?** lists the keyboard shortcuts: `g i` Inbox, `g c` Campaigns, `g d` Dashboard, `g s` Settings, `g m` switch to Mail, `g e` switch to Sign.
- The theme switch offers System, Light or Dark.

---

## 2. Mail, Sign and roles

MailFlow has two products. Switch between them with the product switcher at the top of the sidebar.

- **Mail**: Quick Send, Dashboard, Inbox, Data, Contacts, Campaigns, Templates, PDF Library, Automations, Batches, Suppressions, Deliverability, Performance, Reports, History.
- **Sign**: Documents, New Request, Bulk Send, Templates, Analytics, PDF Library.

| Role | Can do |
|---|---|
| **Viewer** | Read everything in their workspace. Cannot edit, send or reply. |
| **Operator** | Import data, build templates and campaigns, run dry runs, submit campaigns and Quick Sends for approval, reply in the Inbox, run automations, send documents for signature. |
| **Admin** | Everything an Operator can, plus: approve or reject other people's requests, Send without approval, Quick Send without approval, **Recruiter Bulk Send** and **Mailbox usage**. Cannot approve their own request. |
| **Super Admin** | Everything, organisation-wide: Organization (with the "Everything sent" ledger), Users, Workspaces, All Data, All Conversations, Audit Logs, System Settings, user registrations, and read-only, audited "View workspace as". |

Every person has their own **workspace**: their data, templates, campaigns and inbox. Nobody else sees it unless:
- they share their inbox with you, or
- a Super Admin opens it with View As.

---

## 3. Data and contacts

### 3.1 Import a list (Data)
- **+ Dataset** or **Import**. Paste from Google Sheets or Excel with the header row, or upload CSV / XLSX.
- The preview detects headers and column types. It flags duplicate emails: Keep first, Keep latest, or Import all.
- **Set the email column's type to EMAIL.** That makes the dataset sendable and links each row to a Contact.
- **Importing never sends anything.** Neither do previews, dry runs or AI suggestions.

### 3.2 Work the grid
- Double-click a cell to edit. Click a header to sort.
- **Filter** builds conditions (equals, contains, is empty…).
- **Group by** shows counts per value.
- **Search** matches every column.
- **Save view** keeps a filter for everyone who uses the dataset.
- **Bulk edit**: tick rows, then *Set column… to value*, then Apply.
- Large lists are paged. Every list in MailFlow shows **"Showing x–y of N"** with the full total, and you can jump to a page.

### 3.3 Contacts and segments
- **Contacts** is everyone you have emailed or who wrote to you. Each contact has a timeline of every email, reply, note and status change.
- **Fill missing names** adds names to contacts that have none. It uses your recipient lists and their own replies, and never overwrites a name.
- **Profile photos** appear once you turn them on in Settings → Gmail.
- **Segments** (Contacts → Segments) save a group of contacts by rule. Members are paged. Quick Send can send to a segment.

---

## 4. Templates and campaigns

### 4.1 Templates
- Subject and body use the list's columns as variables: `{{Name}}`, `{{Deadline}}`. Insert them with **+ Insert variable** so the spelling matches the column.
- **Preview as** a real person shows the filled-in email. Anything unfilled is listed in yellow.
- The **AI assistant** can draft, shorten, fix grammar or translate.
- **Run health check** catches missing variables, broken links and a missing mailbox.
- Every save is a new version. A campaign keeps the version it was created with, so later edits never change an email that already went out.

### 4.2 Build and send a campaign
1. **+ Campaign**: name, dataset, template.
2. **Sender settings**:
   - From name, Reply-To, and CC / BCC. CC and BCC go on **every** email.
   - **PDF attachments**, uploaded or picked from the **PDF Library**.
   - Optional **RSVP buttons** ("I'll attend / Can't make it"). The answers are saved for you.
3. **Backup mailboxes**: tick teammates' mailboxes that are offered as backups.
   - They are used only when your mailbox reaches Google's daily limit, is slowed down or is disconnected.
   - Replies still come back to you and the campaign.
4. **Run simulation**: shows exactly who would get it and who is skipped and why (invalid, duplicate, unsubscribed, bounced). Nothing is sent.
5. **Review** the rendered email for at least three people.
6. **Submit for approval**. Once approved, **Send now** or schedule it. Admins can **Send without approval**.

### 4.3 Approve (Admins)
- **Approvals** lists the campaigns and Quick Sends waiting for a decision, with a total and paging. Super Admins also see **User Registrations** there.
- **Approve** takes optional remarks. **Reject** needs a reason, which the requester sees.
- The decision is emailed back in the same thread.
- You cannot approve your own request.

### 4.4 Watch the send (Batches)
- Every send shows live progress: sent, failed, skipped and still queued.
- **Pause**, **Resume**, **Cancel**, **Retry failed** and **Process queue** act immediately.
- Emails leave at about 20 per minute per mailbox, so 300 people take about 15 minutes.

### 4.5 When someone replies (reply rules)
On a campaign, **When someone replies** lets you react by reply type:
- Interested, Not interested, Asks a question, Asks for something, Complains.
- Needs action, Done what was asked, Just says thanks, Out of office.

For each type you can:
- reply with a template, either as a draft for approval or automatically in the same thread;
- not reply;
- assign the conversation to someone;
- write a value into a data column.

AI must be switched on for reply rules to work.

### 4.6 Automations
- An automation sends a template when a record matches conditions. A cooldown stops anyone being emailed twice by mistake.
- Stop conditions such as *Reply Received = true* always win.
- When you enable one, it shows how many records it would affect right now and asks you to confirm.
- Every run is listed with a "Why?" explanation.

---

## 5. Quick Send

Quick Send is for a one-off email to a list, without building a dataset and template first. Every email is personalised and tracked (opens, clicks, replies), and has an unsubscribe link.

1. **Who gets it**. Any of these works:
   - one email per line, or `Name, email` per line;
   - rows copied straight from Sheets / Excel, with the header row;
   - a list from Data, or a segment.
2. **The email**:
   - Write it, or start from a template. Use `{{Name}}` and other column names.
   - Add PDFs (up to 4 MB each, 10 MB in total), or pick them from the PDF Library.
   - Optional RSVP buttons.
3. **More options**: sender name, Reply-To, Cc / Bcc, send later, and backup mailboxes.
4. **Ready to send?** shows a check and a preview of the real email as you type. Then send.

Who needs approval:
- **Admins** send straight away.
- **Operators'** Quick Sends go to an admin for approval and then send by themselves. You get an email when yours is approved.

**Your recent Quick Sends** shows progress and updates every few seconds.

---

## 6. Recruiter Bulk Send (Admins)

Use this to email many recruiters at once, from one or several mailboxes. It has seven steps; **Open all steps** shows them together.

1. **Recruiters**
   - Paste a sheet with a header row, upload CSV / Excel, or choose saved data.
   - Choose the **email address column**.
   - The other columns appear as chips you can use in the email.
2. **How it goes out**
   - **BCC groups**: up to 250 recruiters per email, with a visible "To" address.
   - **Individual copies**: one email per recruiter.
   - **Pause between emails from the same mailbox**, in seconds.
   - **With more than one mailbox**: **All mailboxes together** (the default; they send in rounds, side by side), or **One mailbox after another**.
3. **The email**
   - Subject, Simple or HTML, and Personalise chips.
   - Variables look like `{{Company}}`. Add a fallback for empty cells: `{{Name | there}}`.
   - **Per-recruiter tracking link**: put each recruiter's link in a column (for example *UTM link*) and use `href="{{UTM link}}"`. Links are sent exactly as written; there is no click tracking.
   - Also: From name, CC (up to 10), Reply-To, and "Add my email signature".
4. **Attachments and video**
   - Up to 5 PDFs, from your computer or the PDF Library.
   - A video, either attached (up to 20 MB) or shared as a link. A link shows a "▶ Watch the video" button.
   - Drive videos must be shared as "Anyone with the link".
5. **Send from**: choose one or more mailboxes, yours and teammates' backups. Each shows its usage today and its limit.
6. **Batches and who receives it**
   - A summary of every batch and which mailbox sends it.
   - **Click a recruiter** to see exactly the email they will get. Use ‹ › or ↑ ↓ to move through them.
7. **Check and send**: **Send a test to me** first, then send now or schedule it.

Rules worth knowing:
- **Variables need Individual copies.** A BCC email is one email for many people, so it cannot say each recruiter's name.
- A variable that is not a column blocks the send.
- Recruiters whose cell is empty, with no fallback, are skipped. The review tells you who.
- **Reply-To always includes the sending mailbox**, so MailFlow tracks every reply even when you add your own Reply-To.
- With individual copies, every CC address gets one copy per recruiter. So CC works only for up to 50 recruiters; for more, use BCC groups or remove the CC.
- While it runs, you can **Pause**, **Resume** or **Cancel**. Each mailbox has its own pause and limit.
- The progress list shows every recruiter. Click one to see the email they got.
- You can copy a past send to start a new one.
- **Replies land in the Inbox of the admin who sent it**, assigned to them, whichever mailbox sent the email.

---

## 7. Inbox and replies

- Replies to emails MailFlow sent arrive in the Inbox.
- Gmail is checked automatically every 30 minutes. It is checked again when you open the Inbox, if the last check was more than 2 minutes ago.
- **Sync now** fetches the latest straight away.
- Bounces, out-of-office messages and auto-replies are recognised. They never count as "they replied".
- In a conversation you can:
  - reply in the same thread;
  - attach files (up to 4 MB per reply, including signed documents);
  - add an internal note, tag, assign, or set a follow-up;
  - schedule a reply;
  - change the status.
- **AI suggest reply** drafts text you can edit.
- **Saved replies** (Settings → Saved replies) are reusable answers you insert while replying.
- **Inbox sharing** (Settings → Inbox sharing) shares your inbox with the whole organisation or with specific people. Choose *Can view* or *Can view and reply*.
- **SLA rules** (Settings → SLA rules) set how fast conversations should get a first reply and be resolved.
- **Replies to bounced or spam-reported addresses are blocked**, to protect everyone's sending reputation.

---

## 8. Unsubscribes and suppressions

- **Every bulk email has an Unsubscribe button.** That covers campaigns, Quick Send, automations and Recruiter Bulk Send, including BCC emails.
- On personal emails it is a one-click link. Personal emails are campaigns, Quick Send, automations and individual copies.
- On a BCC email, the button opens a pre-filled email to the sending mailbox ("Unsubscribe rb-…").
  - MailFlow reads that email, suppresses the person, and skips them for the rest of the send.
  - There is also an "unsubscribe on the web" link.
- **Suppressions** lists everyone MailFlow will not email. Each entry shows:
  - the reason: Unsubscribed, Bounced or Marked as spam;
  - who added it: you, the recipient's unsubscribe link, or the system.
- **Bounces and spam reports apply to the whole organisation** and carry an **Org-wide** badge. An address that bounced for a teammate is skipped for you too ("System (teammate's bounce)").
- Unsubscribes apply to your workspace.
- You can add an address by hand (Unsubscribed or Complaint, with a note), or remove one you added.

---

## 9. Sign (e-signatures)

- **New Request**. Fill in:
  - document name, signer name and email, and CC (one per line);
  - custom fields such as `{{stipend}}`;
  - an optional invitation email and extra attachments;
  - when the link expires (7 days by default).

  Or load a template.
- **Bulk Send** makes one document per row, from a CSV or a Data list, with a template.
  - With several signers, choose *Signer 1 → 2 → 3* (in order) or *all sign at once*.
  - Choose which signer fills which fields.
- **Templates** hold reusable documents with fields. The **PDF Library** holds PDFs shared by Mail and Sign.
- **Documents** lists every request and its status. Signers who have not signed get a reminder every 2 days, up to 3 reminders.
- If an invitation email fails, the document shows a warning with **Resend**.
- Bulk void and resend report any that failed. **Void all** asks you first.
- A voided link tells the signer that the sender cancelled it.
- **Analytics** shows documents sent and signed, the sign rate and the average time to sign.

---

## 10. Reports and numbers

### 10.1 In the app
- **Dashboard**: live numbers for your workspace, and quick actions.
- **Deliverability**, for the last 7, 30 or 90 days:
  - emails sent, opened and clicked (people only);
  - bounce and unsubscribe rates against healthy levels;
  - domain authentication (SPF, DKIM, DMARC);
  - each mailbox in the last 24 hours;
  - recent bounces.
- **Performance**: the team's numbers per person.
- **Reports**: documents sent and signed, emails sent, open and click rates, conversations, and resolution rate.
- Date ranges are in IST and include today.
- **History**: every email sent, with its outcome and a "Why?", and every message received.

### 10.2 Daily report — 8 PM IST, Monday to Friday
- **When**: 8 PM IST, Monday to Friday.
- **What it covers**: 8 PM on the previous working day to 8 PM today.
  - Work done after 8 PM goes into the next report.
  - **The weekend goes into Monday's report.**
  - A "What this report covers" card at the top gives the exact hours.
- **Contents**:
  - totals;
  - sends by type and by person;
  - who used whose mailbox;
  - the inbox per person: received, pending, closed, first and average response time, for today and the last 30 days;
  - what needs attention.
- **Who gets it**:
  - the To and CC people set in System Settings, who can see each other;
  - if none are set, the admins, by BCC.
- **Slack**: it posts to its own channel as "MailFlow Daily Report".

### 10.3 Weekly report — Monday 9 AM IST
- Same design as the daily report. It covers last week, Monday to Sunday, day by day, compared with the week before.
- Super Admins can test both reports in System Settings → Reports & triage: **Preview latest**, **Send test to me** and **Send test to Slack**, with Email and Slack preview tabs.

---

## 11. Admin and Super Admin

- **Mailbox usage** (Admins) shows each mailbox's last 24 hours against the limits of 1,500 emails and 1,800 different people. Use it to pick mailboxes with room.
- **Organization** shows users, workspaces, emails, replies and campaigns over 7, 30 or 90 days. It also holds the **Everything sent** ledger:
  - filter by period, workspace, who launched it, mailbox, type, status, or *only from someone else's mailbox*;
  - download it as CSV;
  - the 7d / 30d / 90d links keep your filters.
- **Users**: roles, enable and disable. You cannot disable yourself or remove the last Super Admin.
- **Workspaces**: **View Workspace** opens one read-only under a red banner. Entry and exit are audited.
- **All Data**, **All Conversations** and **Audit Logs** are organisation-wide, and every view is audited.
- **System Settings** has its own section menu:
  - Data retention;
  - Reports & triage (daily report, weekly report, AI inbox triage);
  - Slack;
  - Runtime.

---

## 12. Settings

Settings has a section menu on the left; on a phone it becomes chips across the top. The section you are looking at is highlighted.

| Group | Sections |
|---|---|
| **You** | Profile, Gmail (connect, backup sender, profile photos), Email signature |
| **Inbox** | Saved replies, Inbox sharing |
| **Workspace** | SLA rules, Webhooks, and Server (cloud or laptop) for Super Admins |

The app uses the Masai look:
- the Masai logo in the sidebar, white in dark mode;
- Masai red buttons;
- the round Masai "m" as the browser-tab icon.

E-sign emails use the same red.

---

## 13. Before you send (checklist)

- [ ] Gmail connected and a **test email** received.
- [ ] The right **email column** is chosen and duplicates are handled.
- [ ] Every `{{variable}}` fills in for at least three people (use Preview as, or click a recruiter). Empty cells have a fallback, such as `{{Name | there}}`.
- [ ] The **recipient count** matches what you expect, and every skip reason makes sense.
- [ ] From name, Reply-To and CC / BCC are right. CC and BCC go on **every** email.
- [ ] The sending mailboxes have room today (check **Mailbox usage**), and backups are ticked if needed.
- [ ] Attachments open, links work, and Drive videos are shared "Anyone with the link".
- [ ] It is approved, if your role needs approval.
- [ ] After sending, you watched progress to the end and checked failures in **Batches** or **History**.

---

## 14. Limits to know

**Only these send email:**
- *Send now* on an approved campaign;
- *Send without approval* by an admin;
- Quick Send;
- Recruiter Bulk Send;
- a scheduled send;
- an inbox reply you send or schedule;
- an enabled automation;
- an automatic reply rule.

Nothing else does.

- **Per mailbox, per 24 hours**: 1,500 emails and 1,800 different people. This keeps you under Google's own limits. Check **Mailbox usage**. Backup mailboxes take over when yours is full.
- **Speed**: about 20 emails per minute per mailbox by default. Recruiter Bulk Send uses the pause you set.
- **Attachments**:
  - Quick Send: PDFs up to 4 MB each and 10 MB in total.
  - Recruiter Bulk Send: up to 5 PDFs, and a video up to 20 MB (or a link of any size).
  - Inbox replies: up to 4 MB.
- **Recruiter Bulk Send**: up to 250 recruiters per BCC email, and CC up to 10 people.
- **Data grid**: up to 100,000 rows per dataset.
- **AI**: daily limits per person and per organisation (see System Settings). If AI is unavailable, carry on by hand; nothing else is affected.

---

## 15. If something goes wrong

| Symptom | Do this |
|---|---|
| Can't get in after sign-in | A new account waits for a Super Admin to approve it. "Not permitted" means the account was disabled: contact a Super Admin. |
| Gmail connect errors | Settings → Gmail → Connect again, choosing your own Masai account. |
| "Sender not connected" | Connect Gmail in Settings, then try again. |
| Mailbox hit its limit | Pick another mailbox or a backup (Mailbox usage shows who has room), or send tomorrow. |
| Send stuck in Queued | Batches → **Process queue**. If it keeps failing, open History for the reason. |
| Recruiter send blocked | The page lists why. Usually one of: a variable doesn't match a column; variables are used with BCC (switch to Individual copies); or CC is set on individual copies to more than 50 recruiters. |
| No replies appearing | Inbox → **Sync now**. Only replies to emails MailFlow sent come in. |
| "Can't reply to this address" | The address bounced or reported spam. It is on Suppressions and stays blocked. |
| Signer didn't get the email | Open the document and click **Resend**. |
| Can't find Approve | Only Admins and Super Admins see Approvals, and you cannot approve your own request. |

**Owner:** Abhishesh Kumar (abhishesh.kumar@masaischool.com). For bugs and requests, send the page URL and what you expected to happen.
