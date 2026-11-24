# Organisation lifecycle: seats, validity, payments, lock

Product spec for selling MailFlow to teams / customers ("organisations"). A Super Admin (the platform owner) controls each
organisation's life; customers cannot change their own limits or dates.

## Who does what

| Person | Can |
|---|---|
| Super Admin (platform owner) | create / rename / disable / enable organisations, set seat limits, record a payment and activate or extend validity, assign people, approve sign-ups |
| Admin (customer's admin) | sees their organisation's banner and the lock screen, can send a renewal request to the Super Admins |
| Everyone else in the organisation | sees the banner, and the lock screen after expiry |

Super Admins are never locked out (they run the platform), whichever organisation they sit in.

## States (derived, never stored)

`state = accessOf(org, now)` in `lib/orgs/lifecycle.ts`.

| State | When | What people see | What is locked |
|---|---|---|---|
| ACTIVE | enabled, no expiry or more than 30 days left | nothing | nothing |
| EXPIRING | enabled, 30 days or fewer left | renewal banner (info, then warning at 14, urgent at 7, 3, 1 days) | nothing |
| GRACE | past the end date, inside `graceDays` (default 0) | red banner: "expired, locks on <date>" | nothing |
| EXPIRED | past the end date and grace | lock screen with "ask your admin to renew" and a request button | everything except the Dashboard (read-only) |
| DISABLED | a Super Admin disabled the organisation | lock screen: "organisation is disabled" | everything, Dashboard included |

Dates are India time: "valid until 30 Nov" means until 23:59:59 IST on 30 Nov.

## Seats

`seatLimit` = the most ACTIVE people the organisation may have (null = unlimited). Pending sign-ups do not use a seat. A seat is
taken when someone is approved (or re-enabled) or moved in. Approving or moving in beyond the limit is refused with the numbers
("5 of 5 seats used"). The limit cannot be lowered below the people already active.

## Payments and activation

Payment is taken outside MailFlow (bank transfer, UPI, invoice). When it arrives the Super Admin opens the organisation and
chooses **Activate / extend**:

* "Add N days": counted from today, or from the current end date when that is later (so renewing early loses nothing);
* or "Valid until a date".

Each activation is saved as a payment record: amount and currency (optional), reference (transaction id / invoice number), a
note, the days added, the period start, the old and new end dates and who recorded it. This is the audit trail and the base for
invoicing later. A payment gateway can later call the same function (`activateOrg`) from a webhook.

## Renewal reminders

* In the app: the banner on every page for the organisation's people while EXPIRING / GRACE.
* To the Super Admins: an in-app notification once at 30, 14, 7, 3, 1 days and on the day (daily job), so renewals are chased
  before the customer is locked.

## What "locked" does

* Pages: everything except the Dashboard shows the lock screen (DISABLED: the Dashboard too). Sign-in still works.
* API: every request from a locked organisation's people is answered 402 "organisation expired" except the few the Dashboard and the
  lock screen need.
* Sending stops: queued emails, Recruiter Bulk Sends, scheduled sends, follow-ups and automations of a locked organisation are held (not
  failed, not deleted) and carry on when it is renewed.
* Public links keep working: unsubscribe, open/click tracking, webhooks. Mailboxes stay connected. Inbound reply sync and the bounce
  scan keep running (they protect deliverability and cost nothing to the customer).
* Data is kept untouched. Renewing restores everything at once.

## Existing organisations

Masai School and Neev Labs are migrated as ACTIVE, no expiry, no seat limit: nothing changes for them until a Super Admin sets one.

## Out of scope (written down so it is a decision, not an oversight)

* a payment gateway (the activation function is ready for a webhook);
* organisation admins approving their own people (approvals stay with the Super Admin);
* automatic deletion of data after a long expiry (a retention rule for the future).
