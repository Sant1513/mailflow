/**
 * Personalised documents — end-to-end smoke test.
 *
 * Real database + the running app over HTTP with throwaway fixture users,
 * then the REAL send pipeline (drainBatch → processEmailJob) with a fake
 * email provider, so no email leaves the machine. Covers upload and
 * inspection, the field map, previews, campaign snapshots and drift, the
 * dry-run skip reason, approval locking, per-job value freezing, generation
 * at send time, the SHA-256 proof, downloads, access control and cleanup.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/smoke-test-documents.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import { prisma } from '../lib/db/client';
import { drainBatch } from '../lib/queue/drain';
import type { EmailProvider, SendEmailInput } from '../lib/email/provider';
import { ColumnType, EmailProvider as EmailProviderEnum, Role } from '@prisma/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SESSION_COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '');
  }
}

async function createSessionFor(userId: string) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken, userId, expires: new Date(Date.now() + 3600_000) } });
  return `${SESSION_COOKIE}=${sessionToken}`;
}

async function call(path: string, cookie: string | null, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...((init.headers as Record<string, string>) ?? {}) },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    /* binary or HTML */
  }
  return { status: res.status, json, bytes, headers: res.headers };
}

const send = (path: string, cookie: string, method: string, body?: unknown) =>
  call(path, cookie, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

function upload(path: string, cookie: string, bytes: Uint8Array | Buffer, fileName: string, type = 'application/pdf') {
  const form = new FormData();
  // Normalize to ArrayBuffer to avoid TypeScript's ArrayBufferLike strictness in test scripts.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  form.append('file', new Blob([ab], { type }), fileName);
  return call(path, cookie, { method: 'POST', body: form });
}

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const hex = (text: string) => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

function pageContent(doc: PDFDocument, index: number): string {
  const contents = doc.getPage(index).node.get(PDFName.of('Contents'));
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs
    .map((ref) => doc.context.lookup(ref as never))
    .map((stream) => {
      if (!(stream instanceof PDFRawStream)) return '';
      const raw = Buffer.from(stream.getContents());
      return (stream.dict.get(PDFName.of('Filter')) ? zlib.inflateSync(raw) : raw).toString('latin1');
    })
    .join('\n')
    .toUpperCase();
}

async function agreementPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = doc.embedStandardFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Placement Agreement', { x: 50, y: 790, size: 16, font: bold });
  page.drawText('Student name', { x: 50, y: 728, size: 11 });
  page.drawText('Batch', { x: 50, y: 696, size: 11 });
  page.drawText('I agree to the terms', { x: 50, y: 664, size: 11 });
  page.drawText('Joining date', { x: 50, y: 634, size: 11 });
  const form = doc.getForm();
  form.createTextField('student_name').addToPage(page, { x: 150, y: 722, width: 250, height: 20 });
  const batch = form.createDropdown('batch');
  batch.addOptions(['FT-WEB-12', 'FT-WEB-13']);
  batch.addToPage(page, { x: 150, y: 690, width: 150, height: 20 });
  form.createCheckBox('consent').addToPage(page, { x: 150, y: 660, width: 12, height: 12 });
  doc.addPage([595.28, 841.89]).drawText('Terms and conditions', { x: 50, y: 790, size: 12, font: bold });
  return doc.save();
}

async function main() {
  console.log(`=== Personalised documents smoke test against ${BASE_URL} ===\n`);
  const stamp = Date.now();
  const org = await prisma.organization.upsert({
    where: { allowedDomain: 'masaischool.com' },
    update: {},
    create: { name: 'Masai School', allowedDomain: 'masaischool.com' },
  });

  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const mk = async (tag: string, role: Role) => {
    const u = await prisma.user.create({
      data: { organizationId: org.id, googleId: `docs-${tag}-${stamp}`, email: `docs-${tag}+${stamp}@masaischool.com`, name: `Docs ${tag}`, role },
    });
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: u.id, name: `Docs ${tag} WS ${stamp}` } });
    userIds.push(u.id);
    workspaceIds.push(ws.id);
    return { u, ws, cookie: await createSessionFor(u.id) };
  };
  const owner = await mk('owner', Role.OPERATOR);
  const admin = await mk('admin', Role.SUPER_ADMIN);
  const outsider = await mk('outsider', Role.OPERATOR);
  const viewer = await mk('viewer', Role.VIEWER);

  let campaignId: string | null = null;
  const fakeSent: SendEmailInput[] = [];

  try {
    // ── Fixtures: dataset with contacts, an email template ──
    const dataset = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: owner.ws.id, ownerId: owner.u.id, name: `Docs dataset ${stamp}` } });
    await prisma.datasetColumn.createMany({
      data: [
        { datasetId: dataset.id, key: 'Name', label: 'Name', type: ColumnType.TEXT, order: 0 },
        { datasetId: dataset.id, key: 'Email', label: 'Email', type: ColumnType.EMAIL, order: 1 },
        { datasetId: dataset.id, key: 'Batch', label: 'Batch', type: ColumnType.TEXT, order: 2 },
        { datasetId: dataset.id, key: 'JoiningDate', label: 'Joining date', type: ColumnType.DATE, order: 3 },
        { datasetId: dataset.id, key: 'Consent', label: 'Consent', type: ColumnType.TEXT, order: 4 },
      ],
    });
    const people = [
      { Name: 'rahul sharma', Email: `rahul.docs+${stamp}@example.com`, Batch: 'ft-web-13', JoiningDate: '2026-10-01', Consent: 'Yes' },
      { Name: 'Priya Nair', Email: `priya.docs+${stamp}@example.com`, Batch: 'FT-WEB-12', JoiningDate: '05/10/2026', Consent: 'No' },
      { Name: 'Arjun Rao', Email: `arjun.docs+${stamp}@example.com`, Batch: 'FT-WEB-12', JoiningDate: '', Consent: 'Yes' },
    ];
    const records = [];
    for (const p of people) {
      const contact = await prisma.contact.create({ data: { organizationId: org.id, workspaceId: owner.ws.id, primaryEmail: p.Email, name: p.Name } });
      records.push(await prisma.record.create({ data: { datasetId: dataset.id, contactId: contact.id, data: p } }));
    }
    const template = await prisma.template.create({
      data: {
        organizationId: org.id,
        workspaceId: owner.ws.id,
        ownerId: owner.u.id,
        name: `Docs template ${stamp}`,
        versions: {
          create: { version: 1, subject: 'Your agreement, {{Name}}', html: '<p>Hi {{Name}}, your agreement is attached.</p>', plainText: 'Hi {{Name}}', variables: ['Name'], createdById: owner.u.id },
        },
      },
    });

    // ── §1 Library upload ──
    console.log('-- §1 upload and inspection --');
    const pdf = await agreementPdf();
    let r = await upload('/api/documents', viewer.cookie, pdf, 'Agreement.pdf');
    check('viewer cannot upload (403)', r.status === 403, r.status);
    r = await upload('/api/documents', owner.cookie, Buffer.from('not a pdf at all'), 'notes.pdf');
    check('a non-PDF is rejected with a clear message (400)', r.status === 400 && /not a PDF/i.test(r.json?.error), r.json);
    r = await upload('/api/documents', owner.cookie, pdf, 'Placement Agreement.pdf');
    check('owner uploads the agreement (201)', r.status === 201, r.json);
    check('inspection finds 2 pages and 3 fillable fields', r.json?.inspection?.pageCount === 2 && r.json?.inspection?.formFields?.length === 3, r.json?.inspection);
    const documentId: string = r.json?.document?.id;
    check('the document is named from the file', r.json?.document?.name === 'Placement Agreement', r.json?.document);

    r = await call(`/api/documents/${documentId}`, outsider.cookie);
    check('another workspace cannot open it (403)', r.status === 403, r.status);
    r = await call('/api/documents', owner.cookie);
    const row = r.json?.documents?.find((d: any) => d.id === documentId);
    check('library lists it: 3 fillable, 0 mapped', row?.formFieldCount === 3 && row?.fieldCount === 0, row);
    r = await call(`/api/documents/${documentId}/file`, owner.cookie);
    check('the stored PDF is byte-identical to the upload', r.status === 200 && r.headers.get('content-type') === 'application/pdf' && sha(r.bytes) === sha(pdf), { status: r.status });

    r = await upload('/api/documents', owner.cookie, pdf, 'Copy.pdf');
    const duplicateId = r.json?.document?.id;
    const fileRows = await prisma.documentFile.count({ where: { organizationId: org.id, sha256: sha(pdf) } });
    check('uploading the same bytes again reuses the stored file', r.status === 201 && fileRows === 1, { fileRows });
    r = await send(`/api/documents/${duplicateId}`, owner.cookie, 'DELETE');
    check('an unused document is deleted outright', r.status === 200 && r.json?.ok === true, r.json);
    check('the shared file survives while the first document uses it', (await prisma.documentFile.count({ where: { sha256: sha(pdf) } })) === 1);

    // ── §2 Field map ──
    console.log('-- §2 field map --');
    const goodFields = [
      { id: 'f1', label: 'Student name', value: '{{Name}}', format: { case: 'title' }, target: { kind: 'form', fieldName: 'student_name' } },
      { id: 'f2', label: 'Batch', value: '{{Batch}}', target: { kind: 'form', fieldName: 'batch' } },
      { id: 'f3', label: 'Consent', value: '{{Consent}}', required: false, target: { kind: 'form', fieldName: 'consent' } },
      { id: 'f4', label: 'Joining date', value: '{{JoiningDate}}', format: { date: 'D MMMM YYYY' }, target: { kind: 'text', page: 0, x: 150, y: 196, width: 220, height: 18 } },
      { id: 'f5', label: 'Reference', value: 'Issued as {{DocumentId}} to {{RecipientEmail}}', target: { kind: 'text', page: 1, x: 50, y: 90, width: 480, height: 18 } },
    ];
    r = await send(`/api/documents/${documentId}`, owner.cookie, 'PATCH', {
      fields: goodFields,
      fileNamePattern: 'Placement Agreement - {{Name}}.pdf',
      lockMode: 'LOCK_FILLED',
      stampReference: true,
    });
    check('field map saves with no issues', r.status === 200 && r.json?.issues?.length === 0 && r.json?.document?.fields?.length === 5, r.json?.issues ?? r.json);
    r = await send(`/api/documents/${documentId}`, owner.cookie, 'PATCH', {
      fields: [...goodFields, { id: 'f6', label: 'Ghost', value: 'x', target: { kind: 'form', fieldName: 'no_such_field' } }],
    });
    check('a field pointing at a missing form field saves but is reported as an error', r.status === 200 && r.json?.issues?.some((i: any) => i.level === 'error' && i.fieldId === 'f6'), r.json?.issues);
    r = await send(`/api/documents/${documentId}`, owner.cookie, 'PATCH', { fields: [{ ...goodFields[0], label: '' }] });
    check('an empty label is rejected by validation (400)', r.status === 400, r.status);
    r = await send(`/api/documents/${documentId}`, owner.cookie, 'PATCH', { fields: goodFields });
    check('field map restored', r.status === 200 && r.json?.issues?.length === 0, r.json?.issues);

    // ── §3 Library preview ──
    console.log('-- §3 preview --');
    r = await send(`/api/documents/${documentId}/preview`, owner.cookie, 'POST', {});
    check('placement preview renders without a record', r.status === 200 && r.json?.preview?.ok === true && r.json.preview.fields[0].value === '{{Name}}', r.json?.preview?.error ?? r.json);
    r = await send(`/api/documents/${documentId}/preview`, owner.cookie, 'POST', { recordId: records[0]!.id });
    const preview = r.json?.preview;
    check('record preview uses the personalised file name', preview?.fileName === 'Placement Agreement - Rahul Sharma.pdf', preview?.fileName);
    if (preview?.pdfBase64) {
      const doc = await PDFDocument.load(Buffer.from(preview.pdfBase64, 'base64'));
      const form = doc.getForm();
      check('name is filled and title-cased', form.getTextField('student_name').getText() === 'Rahul Sharma');
      check('dropdown matched case-insensitively', form.getDropdown('batch').getSelected()[0] === 'FT-WEB-13');
      check('checkbox ticked for "Yes"', form.getCheckBox('consent').isChecked());
      check('lock-filled mode made the filled fields read-only', form.getTextField('student_name').isReadOnly());
      check('joining date written as a formatted date on page 1', pageContent(doc, 0).includes(hex('1 October 2026')));
    } else {
      check('record preview produced a PDF', false, preview);
    }
    const outsiderDataset = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: outsider.ws.id, ownerId: outsider.u.id, name: `Outsider ${stamp}` } });
    const outsiderRecord = await prisma.record.create({ data: { datasetId: outsiderDataset.id, data: { Name: 'Not yours' } } });
    r = await send(`/api/documents/${documentId}/preview`, owner.cookie, 'POST', { recordId: outsiderRecord.id });
    check("previewing with another workspace's record is refused (400)", r.status === 400, r.json);

    // ── §4 Campaign ──
    console.log('-- §4 campaign snapshot, drift, dry run --');
    r = await send('/api/campaigns', owner.cookie, 'POST', { name: `Docs campaign ${stamp}`, datasetId: dataset.id, templateId: template.id, documentTemplateIds: [documentId] });
    check('campaign created with the document attached (201)', r.status === 201, r.json);
    campaignId = r.json?.campaign?.id;
    r = await call(`/api/campaigns/${campaignId}/documents`, owner.cookie);
    const attached = r.json?.documents?.[0];
    check('campaign has one snapshot, editable, no drift, no issues', r.json?.documents?.length === 1 && r.json.editable && attached?.drift?.length === 0 && attached?.issues?.length === 0, r.json);

    await send(`/api/documents/${documentId}`, owner.cookie, 'PATCH', { fileNamePattern: 'Agreement v2 - {{Name}}.pdf' });
    r = await call(`/api/campaigns/${campaignId}/documents`, owner.cookie);
    check('editing the library shows drift on the campaign, snapshot unchanged', r.json?.documents?.[0]?.drift?.includes('file name changed') && r.json.documents[0].fileNamePattern === 'Placement Agreement - {{Name}}.pdf', r.json?.documents?.[0]);
    r = await send(`/api/campaigns/${campaignId}/documents/${attached.id}`, owner.cookie, 'PATCH', { action: 'refresh' });
    check('update to latest takes a new snapshot', r.status === 200 && r.json?.changes?.includes('file name changed'), r.json);
    r = await call(`/api/campaigns/${campaignId}/documents`, owner.cookie);
    check('no drift after the update', r.json?.documents?.[0]?.drift?.length === 0 && r.json.documents[0].fileNamePattern === 'Agreement v2 - {{Name}}.pdf', r.json?.documents?.[0]);
    r = await send(`/api/campaigns/${campaignId}/documents`, owner.cookie, 'POST', { documentTemplateId: documentId });
    check('attaching the same document twice is refused (409)', r.status === 409, r.json);

    r = await send(`/api/campaigns/${campaignId}/simulate`, owner.cookie, 'POST');
    check('dry run: 2 would send, 1 skipped for a missing document value', r.json?.simulation?.wouldSend === 2 && r.json.simulation.byReason?.MISSING_DOCUMENT_FIELD === 1, r.json?.simulation);
    const skipped = r.json?.simulation?.evaluations?.find((e: any) => e.skipReason === 'MISSING_DOCUMENT_FIELD');
    check('the skip reason names the document and field', skipped?.reasonDetail?.includes('Joining date'), skipped);

    r = await send(`/api/campaigns/${campaignId}/preview`, owner.cookie, 'POST', {});
    const reviewDoc = r.json?.documents?.[0];
    check('review shows the attachment for the first recipient', reviewDoc?.fileName === 'Agreement v2 - Rahul Sharma.pdf', r.json?.documents);
    check('review lists the formatted joining date', reviewDoc?.fields?.find((f: any) => f.id === 'f4')?.value === '1 October 2026', reviewDoc?.fields);
    r = await send(`/api/campaigns/${campaignId}/documents/${attached.id}/preview`, owner.cookie, 'POST', { recordId: records[1]!.id });
    check('campaign preview for Priya renders her copy', r.json?.preview?.ok && r.json.preview.fileName === 'Agreement v2 - Priya Nair.pdf', r.json?.preview?.fileName ?? r.json);
    if (r.json?.preview?.pdfBase64) {
      const doc = await PDFDocument.load(Buffer.from(r.json.preview.pdfBase64, 'base64'));
      check('Priya: day-first date parsed as 5 October', pageContent(doc, 0).includes(hex('5 October 2026')));
      check('Priya: checkbox left unticked for "No"', !doc.getForm().getCheckBox('consent').isChecked());
    }

    // ── §5 Approval locks documents ──
    console.log('-- §5 approval --');
    r = await send(`/api/campaigns/${campaignId}/approval`, owner.cookie, 'POST', { action: 'SUBMIT' });
    check('submitted for approval', r.status === 200 && r.json?.campaign?.status === 'PENDING_APPROVAL', r.json);
    r = await send(`/api/campaigns/${campaignId}/documents/${attached.id}`, owner.cookie, 'DELETE');
    check('documents are locked while pending approval (409)', r.status === 409 && /draft or rejected/.test(r.json?.error), r.json);
    r = await send(`/api/campaigns/${campaignId}/approval`, admin.cookie, 'POST', { action: 'APPROVE' });
    check('approved by an admin', r.status === 200 && r.json?.campaign?.status === 'APPROVED', r.json);

    // ── §6 Send: values frozen per job, PDFs generated at send time ──
    console.log('-- §6 send pipeline (fake provider) --');
    await prisma.emailProviderAccount.create({
      data: { organizationId: org.id, workspaceId: owner.ws.id, userId: owner.u.id, provider: EmailProviderEnum.GMAIL, emailAddress: owner.u.email, displayName: 'Placement Cell', status: 'CONNECTED' },
    });
    r = await send(`/api/campaigns/${campaignId}/send`, owner.cookie, 'POST', {});
    check('send creates a batch: 2 queued, 1 skipped', r.status === 201 && r.json?.batch?.queued === 2 && r.json.batch.skipped === 1, r.json);
    const batchId: string = r.json?.batch?.id;

    const pending = await prisma.attachment.findMany({ where: { emailJob: { batchId } }, include: { emailJob: { select: { toEmail: true } } } });
    check('one frozen document per queued email', pending.length === 2, pending.length);
    const rahulPending = pending.find((a) => a.emailJob?.toEmail === people[0]!.Email);
    const frozen = rahulPending?.fieldValues as any;
    check('frozen values, file name and reference are stored before sending', rahulPending?.filename === 'Agreement v2 - Rahul Sharma.pdf' && frozen?.values?.f1 === 'Rahul Sharma' && /^MF-[0-9A-Z]{8}$/.test(rahulPending?.documentRef ?? '') && frozen?.reference === rahulPending?.documentRef, rahulPending);
    check('nothing is generated until the email is sent', pending.every((a) => a.sha256 === null && a.size === 0));

    const fakeProvider = (): EmailProvider => ({
      name: 'fake',
      async sendEmail(input) {
        fakeSent.push(input);
        return { providerMessageId: `docs-msg-${stamp}-${fakeSent.length}`, threadId: `docs-thread-${stamp}-${fakeSent.length}`, messageIdHeader: `<docs-${stamp}-${fakeSent.length}@masaischool.com>` };
      },
    });
    const drained = await drainBatch(batchId, { providerFactory: fakeProvider });
    check('both emails sent through the real pipeline', drained.sent === 2 && drained.failed === 0, drained);

    const rahulEmail = fakeSent.find((s) => s.to === people[0]!.Email);
    const pdfPart = rahulEmail?.attachments?.[0];
    check('the email carried one application/pdf attachment with the personalised name', rahulEmail?.attachments?.length === 1 && pdfPart?.mimeType === 'application/pdf' && pdfPart.filename === 'Agreement v2 - Rahul Sharma.pdf', rahulEmail?.attachments?.map((a) => a.filename));

    const sentRows = await prisma.attachment.findMany({ where: { emailJob: { batchId } }, include: { emailJob: { select: { toEmail: true } } } });
    const rahulSent = sentRows.find((a) => a.emailJob?.toEmail === people[0]!.Email);
    check('hash and size recorded after sending', !!rahulSent?.sha256 && (rahulSent?.size ?? 0) > 0 && !!rahulSent?.generatedAt, rahulSent);
    if (pdfPart) {
      check('the recorded hash is the hash of the bytes actually attached', sha(pdfPart.content) === rahulSent?.sha256);
      const doc = await PDFDocument.load(pdfPart.content, { updateMetadata: false });
      check('attached PDF: name filled', doc.getForm().getTextField('student_name').getText() === 'Rahul Sharma');
      check('attached PDF: page 2 carries the real reference and recipient', pageContent(doc, 1).includes(hex(`Issued as ${rahulSent?.documentRef} to ${people[0]!.Email}`)));
      check('attached PDF: footer reference line on page 1', pageContent(doc, 0).includes(hex(`Ref ${rahulSent?.documentRef}`)));
      check('attached PDF: reference stored in the keywords metadata', (doc.getKeywords() ?? '').includes(rahulSent?.documentRef ?? '?'));
    }
    const message = rahulSent?.conversationMessageId
      ? await prisma.conversationMessage.findUnique({ where: { id: rahulSent.conversationMessageId }, select: { hasAttachments: true } })
      : null;
    check('the attachment is linked to the outbound message in the inbox thread', message?.hasAttachments === true, { conversationMessageId: rahulSent?.conversationMessageId });

    // ── §7 Proof and downloads ──
    console.log('-- §7 verify and download --');
    r = await call(`/api/attachments/${rahulSent!.id}?verify=1`, owner.cookie);
    check('verify: regenerated copy is identical to what was sent', r.status === 200 && r.json?.verification === 'identical' && r.json.sentSha256 === r.json.regeneratedSha256, r.json);
    r = await call(`/api/attachments/${rahulSent!.id}`, owner.cookie);
    check('download returns the PDF with the verification header', r.status === 200 && r.headers.get('x-mailflow-verification') === 'identical' && sha(r.bytes) === rahulSent?.sha256, { status: r.status, header: r.headers.get('x-mailflow-verification') });
    check('download uses the personalised file name', (r.headers.get('content-disposition') ?? '').includes('Agreement v2 - Rahul Sharma.pdf'), r.headers.get('content-disposition'));
    r = await call(`/api/attachments/${rahulSent!.id}`, outsider.cookie);
    check('another workspace cannot download it (403)', r.status === 403, r.status);
    const downloadAudit = await prisma.auditLog.count({ where: { actorId: owner.u.id, action: 'DOCUMENT_DOWNLOAD', targetId: rahulSent!.id } });
    check('the download is audited', downloadAudit === 1, downloadAudit);

    if (rahulSent?.conversationMessageId) {
      const plain = await prisma.attachment.create({ data: { conversationMessageId: rahulSent.conversationMessageId, filename: 'reply.png', mimeType: 'image/png', size: 10 } });
      r = await call(`/api/attachments/${plain.id}`, owner.cookie);
      check('an ordinary attachment explains that MailFlow keeps no copy (404)', r.status === 404 && /does not keep a copy/.test(r.json?.error), r.json);
    }

    r = await call(`/api/batches/${batchId}`, owner.cookie);
    check('batch job list includes the document per job', r.json?.jobs?.every((j: any) => j.attachments?.length === 1), r.json?.jobs?.map((j: any) => j.attachments));

    r = await send(`/api/documents/${documentId}`, owner.cookie, 'DELETE');
    check('deleting a document a campaign used archives it instead', r.status === 200 && r.json?.archivedInsteadOfDeleted === true, r.json);
  } finally {
    // ── Cleanup (FK-safe order) ──
    console.log('\n-- cleanup --');
    const campaigns = await prisma.campaign.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { id: true } });
    const campaignIds = campaigns.map((c) => c.id);
    const conversations = await prisma.conversation.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { id: true } });
    const conversationIds = conversations.map((c) => c.id);
    await prisma.attachment.deleteMany({ where: { OR: [{ emailJob: { campaignId: { in: campaignIds } } }, { conversationMessage: { conversationId: { in: conversationIds } } }] } });
    const contacts = await prisma.contact.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { id: true } });
    await prisma.recipientHistory.deleteMany({ where: { contactId: { in: contacts.map((c) => c.id) } } });
    await prisma.conversationMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    await prisma.emailJob.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.batch.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.campaignRecord.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.documentTemplate.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.documentFile.deleteMany({ where: { createdById: { in: userIds } } });
    await prisma.templateVersion.deleteMany({ where: { template: { workspaceId: { in: workspaceIds } } } });
    await prisma.template.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.dataset.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.contact.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.emailProviderAccount.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { workspaceId: { in: workspaceIds } }] } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    const leftovers = await prisma.documentFile.count({ where: { createdById: { in: userIds } } });
    check('fixtures removed', leftovers === 0 && (await prisma.user.count({ where: { id: { in: userIds } } })) === 0);
    await prisma.$disconnect();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
