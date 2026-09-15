# Personalised PDF documents in campaigns (10 Sep 2026)

## What was asked

> "Suppose I'm sending a PDF — I want to send a customised one with the fields inside.
> Build this into sending a new campaign. Helpful for agreements and forms."

## Improved request (the spec this build follows)

Build **personalised PDF attachments** for campaigns. An operator uploads a PDF once
(an agreement, offer letter, consent form, NOC, fee receipt), maps places in it to
dataset columns, and every recipient of a campaign receives their own copy with their
details filled in, attached to their email.

### 1. Document library (`/documents`)
- Upload a PDF (max 4 MB, max 50 pages). Reject password-protected PDFs with a clear message.
- MailFlow inspects the file: page count, page sizes, rotation, and every **fillable form
  field** (text, checkbox, dropdown, radio, list) with its position.
- A document template stores: name, description, the PDF, the field map, an output
  **file-name pattern** (e.g. `Offer Letter - {{Name}}.pdf`), a **lock mode**, and whether
  to stamp a **reference line** on every page.
- Replace the PDF later without losing the field map; fields that no longer match are flagged.
- Archive instead of delete when a campaign already uses the document.

### 2. Two ways to put data into the PDF
- **Form fields** — for PDFs that already have fillable fields. Map each form field to a value.
  "Auto-map" matches form field names to dataset columns (`student_name` ↔ `StudentName`).
- **Text on page** — for any PDF (scanned or flat). Draw a box on the page; the value is
  written inside it, auto-shrunk to fit, optionally wrapped over several lines (addresses).
  Font, size, colour and alignment are configurable.

### 3. Values
- A value is text with variables: `{{Name}}`, `{{FirstName}} {{LastName}}`, `Batch {{Batch}}`.
- System variables: `{{Today}}`, `{{SenderName}}`, `{{SenderEmail}}`, `{{CampaignName}}`,
  `{{RecipientEmail}}`, `{{DocumentId}}`. A dataset column with the same name wins.
- Per-field formatting: dates (`15 Sep 2026`, `15 September 2026`, `15/09/2026`, `2026-09-15`,
  `September 15, 2026`), numbers (Indian `1,50,000`, international, `Rs. 1,50,000`),
  and case (UPPER, lower, Title).
- **Required** fields block that recipient when a value is empty (skip reason
  "Missing document value"), exactly like a missing email variable. Optional fields use a
  fallback text or stay blank.
- Checkboxes tick for yes / true / 1 / y / checked. Dropdowns and radios must match an option.

### 4. Lock mode (what the student can do with the PDF)
- **Flatten** — nothing is editable; best for agreements and letters.
- **Lock filled fields** — pre-filled fields are read-only, every other field stays fillable;
  best for forms the student completes and sends back.
- **Editable** — all fields stay editable.

### 5. Campaign integration
- New campaign form: optionally pick documents to attach.
- Campaign page: Documents panel — add, remove, update to the latest version of the document.
  The campaign keeps a **snapshot** (file + field map), so later edits to the library never
  change what an approved campaign sends. Changes are allowed only while the campaign is a
  draft or rejected, so an approval always covers the exact documents that go out.
- Review: for the selected recipient, show every document's file name, each field's value,
  empty required values and warnings, and open the exact PDF they will receive.
- Simulation and send validation: unknown columns, form fields missing from the PDF, and
  text boxes on rotated pages block the send; recipients with empty required values are skipped
  with the reason.
- Approval request email lists the attached documents.

### 6. Sending, proof and audit
- At send time each job stores the resolved values, file name and a unique **document
  reference** (`MF-XXXXXXXX`). The PDF is generated when the email is sent, from the frozen
  snapshot, and attached as a real MIME part.
- Generation is deterministic: the SHA-256 of the attached PDF is stored, and "Download sent
  copy" regenerates the file and confirms it is byte-identical to what went out.
- Sent copies are downloadable from the batch job list and the inbox thread.
- Every library and campaign change is audited; downloads of sent copies are audited.

### Ideas added beyond the request
- Reference stamp + PDF metadata (title, subject, keywords) for verifying a document later.
- Lock-filled-fields mode for forms students fill in and return.
- Auto-map form fields to columns.
- Deterministic generation with hash proof of exactly what each student received.
- Static PDFs work too: a document with no fields is attached unchanged (brochures, policies).

### Honest limits
- Standard PDF fonts cover Latin text (English plus accented letters). Characters outside that
  set (for example Devanagari) are replaced and reported as a warning before sending.
- No password-protecting the generated PDF and no e-signature capture (later).
- XFA (dynamic Adobe LiveCycle) forms are converted to their standard form fields when filled.
- Text boxes are not supported on rotated pages; use form fields there.
- Total attachments per email are capped at 18 MB so the message stays under Gmail's 25 MB limit.
