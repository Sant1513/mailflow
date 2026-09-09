# Build request — inbox composer, message rendering, assignment notifications, CRM extras

_Captured 9 Sep 2026 from product feedback. Each block is one deliverable with acceptance checks._

## 1. Reply composer: rich text, HTML, links, files, preview

**Problem.** The reply box is a plain textarea. Pasting HTML sends it as text, there is no way to attach a file or insert a link, and you cannot see what the student will receive.

**Build.**
- Two editing modes with one source of truth: **Write** (rich text: bold, italic, underline, bullet and numbered lists, link, remove formatting) and **HTML** (the code editor, with Format). Switching modes never loses content.
- **Insert link** (URL + text), **Insert snippet** (saved replies, §4.1), **AI suggest reply** (existing).
- **Attach files**: multiple files, 10 MB total, shown as chips with size, removable. Sent as real MIME attachments through the same Gmail path as campaigns and stored on the outbound message.
- **Preview** tab: the exact email as the student will see it (sanitised HTML, your From name, the thread subject), in a frame with the same **width slider** as the template editor (320–1200 px) plus Desktop / Mobile presets.
- The plain-text alternative is generated from the HTML automatically.

**Accept when:** a reply written in Write mode arrives in Gmail formatted; HTML pasted in HTML mode renders in Preview and in Gmail identically; an attached PDF arrives as an attachment and is listed on the message in the thread; a link inserted from the toolbar is clickable in the sent email.

## 2. Message rendering in the thread

**Problem.** Messages show as plain text with `>` quoted lines; the formatted view is hidden behind a click and renders in a fixed 700 px frame.

**Build.**
- Every message renders its **HTML by default**, sanitised, in a frame that sizes itself to the content (no fixed height, no inner scrollbar), on a white email canvas with images capped to the frame width. Plain-text-only messages render with paragraphs and links preserved.
- **Quoted history is collapsed** ("Show quoted text") for both HTML (Gmail/Outlook quote blocks) and plain text ("On … wrote:", `>` lines), so a thread reads as a conversation, not a pyramid of quotes.
- Attachments are listed under the message with size; inbound attachments keep their metadata (download stays a later item).

**Accept when:** the two screenshots' messages render as formatted email with the quoted history collapsed; a long HTML newsletter shows fully without an inner scrollbar; nothing in a message can run script (sandbox stays on).

## 3. Assignment and resolution notifications (email + Slack, same threads)

**Build.**
- **Slack integration**: bot token from `SLACK_BOT_TOKEN` (environment only, never in the database or UI); the **channel ID** and on/off switches live in System Settings with a **Send test message** button.
- **Slack member ID per user**: editable by super admins on the Users page and by each person on their own Settings page.
- **On assignment** (assignee changed, and it is not the person doing the assigning): email the assignee from the assigner's Gmail (fallback: the conversation's mailbox) with the student, subject, last message and a link; post to the Slack channel mentioning the assignee's Slack ID. Store the email message/thread ids and the Slack thread `ts` on the conversation.
- **On resolution** (status → Resolved or Closed): reply **in the same email thread** and **in the same Slack thread** to the assignee. If there is no assignment thread yet, send a fresh message rather than nothing.
- In-app **Notification** rows are created for the assignee as well (the bell, §4.2). Everything is best effort: a missing mailbox, missing Slack ID or Slack outage never blocks the assignment or status change; the outcome is returned and shown in the toast and stored in the audit log.

**Accept when:** assigning a conversation posts a channel message that mentions the assignee and an email arrives in their inbox; marking it Resolved appears as a reply inside that Slack thread and inside that email thread; with Slack switched off nothing is posted and the assignment still works.

## 4. CRM extras (my additions)

- **4.1 Saved replies (snippets)**: per-workspace reusable replies with variables like `{{Name}}`, managed in Settings, inserted from the composer. Cuts the most repeated typing in placements.
- **4.2 Notification bell**: the app already writes New reply, Assignment and Follow-up due notifications but never shows them. A bell in the nav with unread count, list, mark-read, and links.
- **4.3 Follow-up due reminders**: a scheduled job (every 15 min) that turns due follow-ups into a Notification and a Slack thread reply on that conversation's thread (or a channel message), once per follow-up.
- Noted for later, not built now: SLA highlighting for threads waiting on the team > 48 h; @mentions in internal notes; per-student "do not contact" flag honoured by campaigns and automations; CSV export of any grid view; keyboard shortcuts in the inbox (j/k/r/e).

**Accept when:** a snippet inserts with variables resolved for the conversation's student; the bell shows a count that clears when read; a follow-up set 1 minute in the past produces one reminder in Slack and one in the bell within 15 minutes.

### Assumptions
- Slack messages go to one organisation channel (configurable), mentioning the person; DMs are not used so the team keeps visibility.
- Notification emails are sent from the acting user's mailbox, so they read as coming from a colleague, not a system.
- Attachments are limited to 10 MB per reply (Gmail allows 25 MB; the serverless request limit is the real ceiling).
