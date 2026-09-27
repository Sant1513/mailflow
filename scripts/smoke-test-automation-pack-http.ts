/**
 * Automation pack (27 Sep) — HTTP smoke test with throwaway fixtures:
 * send for signature from Data / a segment, signing write-back, Word
 * template import, AI draft approve/discard, AI triage, Google Sheets
 * connect flow and panel, automation-settings access. Everything created is
 * deleted at the end. Nothing is emailed: the digest / report crons and test
 * sends are not called (they would reach real admins).
 *
 * Usage: BASE_URL=https://<deployed-url> npx tsx scripts/smoke-test-automation-pack-http.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { ColumnType, ConversationStatus, Role } from '@prisma/client';
import { prisma } from '../lib/db/client';
import { syncSigningStatusToRecord } from '../lib/signing/writeback';
import { triageReply } from '../lib/ai/triage';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SESSION_COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
const PREFIX = 'auto-pack+';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

async function call(method: string, path: string, cookie: string | null, body?: unknown, raw?: BodyInit) {
  const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${path}`, { method, redirect: 'manual', headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, location: res.headers.get('location') ?? '', setCookie: res.headers.get('set-cookie') ?? '' };
}

async function docxWith(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const body = paragraphs.map((p) => `<w:p>${p}</w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
const run = (t: string, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;

async function removeFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIX } }, select: { id: true } });
  for (const u of users) {
    const workspaces = await prisma.workspace.findMany({ where: { ownerId: u.id }, select: { id: true } });
    const wsIds = workspaces.map((w) => w.id);
    const convs = await prisma.conversation.findMany({ where: { workspaceId: { in: wsIds } }, select: { id: true, contactId: true } });
    const convIds = convs.map((c) => c.id);
    await prisma.scheduledReply.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.internalNote.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.conversationTag.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.conversationMessage.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
    await prisma.tag.deleteMany({ where: { workspaceId: { in: wsIds } } });
    await prisma.notification.deleteMany({ where: { userId: u.id } });
    await prisma.signingRequest.deleteMany({ where: { workspaceId: { in: wsIds } } });
    await prisma.dataset.deleteMany({ where: { workspaceId: { in: wsIds } } });
    const contacts = await prisma.contact.findMany({ where: { workspaceId: { in: wsIds } }, select: { id: true } });
    await prisma.recipientHistory.deleteMany({ where: { contactId: { in: contacts.map((c) => c.id) } } });
    await prisma.contact.deleteMany({ where: { workspaceId: { in: wsIds } } });
    await prisma.contactSegment.deleteMany({ where: { workspaceId: { in: wsIds } } });
    await prisma.emailProviderAccount.deleteMany({ where: { userId: u.id } });
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.workspace.deleteMany({ where: { id: { in: wsIds } } });
    await prisma.user.delete({ where: { id: u.id } });
  }
  return users.length;
}

async function main() {
  console.log(`=== Automation pack smoke test against ${BASE_URL} ===\n`);
  const leftover = await removeFixtures();
  if (leftover) console.log(`Removed ${leftover} leftover fixture user(s).\n`);

  const stamp = Date.now();
  const org = await prisma.organization.upsert({
    where: { allowedDomain: 'masaischool.com' },
    update: {},
    create: { name: 'Masai School', allowedDomain: 'masaischool.com' },
  });
  const mkUser = async (tag: string, role: Role) => {
    const user = await prisma.user.create({
      data: { organizationId: org.id, googleId: `auto-pack-${tag}-${stamp}`, email: `${PREFIX}${tag}-${stamp}@masaischool.com`, name: `Auto Pack ${tag}`, role },
    });
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: user.id, name: `Auto pack ${tag} ${stamp}` } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({ data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3600_000) } });
    return { user, ws, cookie: `${SESSION_COOKIE}=${token}` };
  };

  try {
    const op = await mkUser('op', Role.OPERATOR);
    const other = await mkUser('other', Role.OPERATOR);

    // ── Data fixtures ──
    const dataset = await prisma.dataset.create({
      data: { organizationId: org.id, workspaceId: op.ws.id, ownerId: op.user.id, name: 'Offer letters fixture' },
    });
    await prisma.datasetColumn.createMany({
      data: [
        { datasetId: dataset.id, key: 'student_name', label: 'Student Name', type: ColumnType.TEXT, order: 1 },
        { datasetId: dataset.id, key: 'personal_email', label: 'Personal Email', type: ColumnType.EMAIL, order: 2 },
        { datasetId: dataset.id, key: 'stipend', label: 'Stipend', type: ColumnType.NUMBER, order: 3 },
      ],
    });
    const contact = await prisma.contact.create({ data: { organizationId: org.id, workspaceId: op.ws.id, name: 'Asha Fixture', primaryEmail: `asha-${stamp}@example.com` } });
    const r1 = await prisma.record.create({ data: { datasetId: dataset.id, contactId: contact.id, data: { student_name: 'Asha Fixture', personal_email: contact.primaryEmail, stipend: 15000 } } });
    const r2 = await prisma.record.create({ data: { datasetId: dataset.id, data: { student_name: 'Bo Fixture', personal_email: `bo-${stamp}@example.com`, stipend: 18000 } } });
    const foreignDs = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: other.ws.id, ownerId: other.user.id, name: 'Other WS fixture' } });
    const foreign = await prisma.record.create({ data: { datasetId: foreignDs.id, data: { student_name: 'Not yours' } } });

    console.log('Send for signature from Data');
    const src = await call('POST', '/api/signing-batches/source', op.cookie, { datasetId: dataset.id, recordIds: [r1.id, r2.id, foreign.id] });
    check('returns the selected rows of this dataset only', src.status === 200 && src.json?.rows?.length === 2, src);
    check('rows carry their record link and display values', src.json?.rows?.[0]?.recordId === r1.id && src.json?.rows?.[0]?.data?.stipend === '15000', src.json?.rows?.[0]);
    check('columns come back in order', src.json?.columns?.map((c: any) => c.key).join(',') === 'student_name,personal_email,stipend', src.json?.columns);
    const cross = await call('POST', '/api/signing-batches/source', op.cookie, { datasetId: foreignDs.id, recordIds: [foreign.id] });
    check('another workspace’s dataset is refused', cross.status === 403 || cross.status === 404, cross.status);
    const unauth = await call('POST', '/api/signing-batches/source', null, { datasetId: dataset.id, recordIds: [r1.id] });
    check('signed out is refused', unauth.status === 401 || (unauth.status >= 300 && unauth.status < 400), unauth.status);

    const segment = await prisma.contactSegment.create({ data: { workspaceId: op.ws.id, createdById: op.user.id, name: 'Asha segment', filters: { name: 'Asha Fixture' } } });
    const seg = await call('POST', '/api/signing-batches/source', op.cookie, { segmentId: segment.id });
    check('a segment returns its contacts with their newest data row', seg.status === 200 && seg.json?.rows?.length === 1 && seg.json.rows[0].recordId === r1.id, seg.json);
    check('segment rows include contact name and email columns', seg.json?.rows?.[0]?.data?.__contact_email === contact.primaryEmail, seg.json?.rows?.[0]);
    const otherSeg = await call('POST', '/api/signing-batches/source', other.cookie, { segmentId: segment.id });
    check('someone else’s segment is refused', otherSeg.status === 403, otherSeg.status);

    const badBatch = await call('POST', '/api/signing-batches', op.cookie, {
      title: 'fixture',
      recipients: [{ name: 'X', email: 'x@example.com', fieldValues: {}, source: { datasetId: foreignDs.id, recordId: foreign.id } }],
      expiresInDays: 7,
    });
    check('a batch linking to another workspace’s row is rejected', badBatch.status === 400 && /outside this workspace/.test(badBatch.json?.error ?? ''), badBatch);

    console.log('\nSigning status written back to the row');
    const req = await prisma.signingRequest.create({
      data: {
        workspaceId: op.ws.id,
        title: 'Offer letter',
        content: '<p>Hi</p>',
        recipientName: 'Asha Fixture',
        recipientEmail: contact.primaryEmail,
        fieldValues: { __recordId: r1.id, __datasetId: dataset.id },
        status: 'SENT',
        sentAt: new Date(Date.now() - 3 * 86_400_000),
        expiresAt: new Date(Date.now() + 4 * 86_400_000),
        sentById: op.user.id,
      },
    });
    await syncSigningStatusToRecord(req.id);
    let row = await prisma.record.findUnique({ where: { id: r1.id } });
    let data = (row?.data ?? {}) as Record<string, unknown>;
    check('sent document: status and days waiting on the row', data.signing_status === 'Sent' && data.days_waiting_to_sign === 3 && data.signing_document === 'Offer letter', data);
    const cols = await prisma.datasetColumn.findMany({ where: { datasetId: dataset.id }, select: { key: true } });
    check('signing columns were added to the dataset', ['signing_status', 'signed_at', 'signed_document_url', 'days_waiting_to_sign'].every((k) => cols.some((c) => c.key === k)), cols);
    await prisma.signingRequest.update({ where: { id: req.id }, data: { status: 'SIGNED', signedAt: new Date() } });
    await syncSigningStatusToRecord(req.id);
    row = await prisma.record.findUnique({ where: { id: r1.id } });
    data = (row?.data ?? {}) as Record<string, unknown>;
    check('signed document: signed date and PDF link, waiting cleared', data.signing_status === 'Signed' && !!data.signed_at && String(data.signed_document_url).includes(`/api/sign/${req.token}/download`) && data.days_waiting_to_sign === null, data);
    const hist = await prisma.recordChangeHistory.count({ where: { recordId: r1.id, reason: 'E-signature' } });
    check('each change is in the row’s history', hist >= 4, hist);
    const foreignReq = await prisma.signingRequest.create({
      data: { workspaceId: op.ws.id, title: 'Sneaky', content: 'x', recipientName: 'x', recipientEmail: 'x@example.com', fieldValues: { __recordId: foreign.id, __datasetId: foreignDs.id }, status: 'SENT', sentAt: new Date(), sentById: op.user.id },
    });
    await syncSigningStatusToRecord(foreignReq.id);
    const foreignAfter = await prisma.record.findUnique({ where: { id: foreign.id } });
    check('a link to another workspace’s row is never written', !(foreignAfter?.data as any)?.signing_status, foreignAfter?.data);

    console.log('\nWord / Google Doc template import');
    const docx = await docxWith([
      run('Dear ') + run('{{student', true) + run('_name}}, your stipend is {{ Stipend }}.'),
      run('Sign here: [[signature]]'),
    ]);
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(docx)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'Offer Letter.docx');
    const imp = await call('POST', '/api/signing-templates/import', op.cookie, undefined, fd);
    check('a .docx converts to template HTML', imp.status === 200 && typeof imp.json?.content === 'string', imp);
    check('fields split by Word formatting are detected', imp.json?.fields?.map((f: any) => f.key).join(',') === 'student_name,stipend', imp.json?.fields);
    check('placeholders and signature token are clean', /\{\{student_name\}\}/.test(imp.json?.content ?? '') && /\{\{stipend\}\}/.test(imp.json?.content ?? '') && (imp.json?.content ?? '').includes('[[signature]]'), imp.json?.content);
    check('title comes from the file name', imp.json?.title === 'Offer Letter', imp.json?.title);
    const badUrl = await call('POST', '/api/signing-templates/import', op.cookie, { url: 'https://example.com/document/d/abc' });
    check('non-Google-Docs links are refused before any fetch', badUrl.status === 400, badUrl);
    const notDocx = new FormData();
    notDocx.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
    const txt = await call('POST', '/api/signing-templates/import', op.cookie, undefined, notDocx);
    check('non-.docx uploads are refused', txt.status === 400, txt);

    console.log('\nAI draft replies');
    const account = await prisma.emailProviderAccount.create({
      data: { organizationId: org.id, workspaceId: op.ws.id, userId: op.user.id, emailAddress: op.user.email, status: 'DISCONNECTED' },
    });
    const conv = await prisma.conversation.create({
      data: {
        organizationId: org.id,
        workspaceId: op.ws.id,
        ownerId: op.user.id,
        contactId: contact.id,
        recipientEmail: contact.primaryEmail,
        subject: 'Offer letter',
        emailProviderAccountId: account.id,
        gmailThreadId: `fixture-${stamp}`,
        status: ConversationStatus.OPEN,
        lastMessageAt: new Date(),
      },
    });
    await prisma.conversationMessage.createMany({
      data: [
        { conversationId: conv.id, direction: 'OUTBOUND', senderEmail: op.user.email, recipientEmail: contact.primaryEmail, cc: [], bcc: [], subject: 'Offer letter', plainTextBody: 'Please sign your offer letter.', sentAt: new Date(Date.now() - 3600_000) },
        { conversationId: conv.id, direction: 'INBOUND', classification: 'HUMAN_REPLY', senderEmail: contact.primaryEmail, recipientEmail: op.user.email, cc: [], bcc: [], subject: 'Re: Offer letter', plainTextBody: 'Thank you so much!', sentAt: new Date() },
      ],
    });
    const draft = await prisma.scheduledReply.create({
      data: { conversationId: conv.id, workspaceId: op.ws.id, createdById: op.user.id, scheduledFor: new Date(), html: '<p>Hi</p>', plainText: 'Hi', cc: [], status: 'DRAFT' },
    });
    const g1 = await call('GET', `/api/conversations/${conv.id}/ai-draft`, op.cookie);
    check('the draft is shown on the conversation', g1.status === 200 && g1.json?.draft?.id === draft.id, g1);
    const inbox = await call('GET', '/api/inbox?filter=all', op.cookie);
    const listed = inbox.json?.conversations?.find((c: any) => c.id === conv.id);
    check('the inbox marks it "AI draft ready"', listed?.aiDraft === true, listed);
    const peek = await call('GET', `/api/conversations/${conv.id}/ai-draft`, other.cookie);
    check('other workspaces can’t see the draft', peek.status === 403 || peek.status === 404, peek.status);
    const discard = await call('PATCH', `/api/conversations/${conv.id}/ai-draft`, op.cookie, { draftId: draft.id, status: 'CANCELLED' });
    check('discard works', discard.status === 200, discard);
    const g2 = await call('GET', `/api/conversations/${conv.id}/ai-draft`, op.cookie);
    check('a discarded draft is gone', g2.json?.draft === null, g2.json);
    const again = await call('PATCH', `/api/conversations/${conv.id}/ai-draft`, op.cookie, { draftId: draft.id, status: 'SENT' });
    check('a discarded draft can’t be marked sent', again.status === 404, again.status);
    const due = await prisma.scheduledReply.count({ where: { status: 'PENDING', conversationId: conv.id } });
    check('drafts never enter the scheduled-send queue', due === 0, due);

    console.log('\nAI triage');
    const settings = await prisma.integrationSettings.findUnique({ where: { organizationId: org.id } }).catch(() => null);
    const triageOn = ((settings as any)?.settings?.triage?.enabled ?? true) && ((settings as any)?.settings?.triage?.autoResolveAcknowledgements ?? true);
    const decision = await triageReply({
      messageId: 'n/a',
      conversationId: conv.id,
      intent: 'ACKNOWLEDGEMENT',
      confidence: 0.95,
      ai: { userId: op.user.id, organizationId: org.id, workspaceId: op.ws.id },
      mailboxEmail: op.user.email,
    });
    if (!triageOn) {
      console.log('  (skipped: triage or auto-resolve is switched off for this organisation)');
    } else {
      const after = await prisma.conversation.findUnique({ where: { id: conv.id }, include: { tags: { include: { tag: true } }, notes: true } });
      check('a confident thank-you is resolved', decision?.resolve === true && after?.status === 'RESOLVED', { decision, status: after?.status });
      check('it is tagged "Thanks"', !!after?.tags.some((t) => t.tag.name === 'Thanks'), after?.tags);
      check('an internal note explains why', !!after?.notes.some((n) => /MailFlow AI marked this resolved/.test(n.body)), after?.notes);
      check('nobody is assigned to a closed thank-you', after?.assigneeId === null, after?.assigneeId);
    }

    console.log('\nGoogle Sheets');
    const panel = await call('GET', `/api/datasets/${dataset.id}/sheet-sync`, op.cookie);
    check('panel loads with no sheet connected', panel.status === 200 && panel.json?.config === null, panel.json);
    check('connect link asks for Sheets and returns to the dataset', (panel.json?.connectUrl ?? '').includes('with=sheets') && decodeURIComponent(panel.json?.connectUrl ?? '').includes(`/data/${dataset.id}`), panel.json?.connectUrl);
    const inspect = await call('POST', `/api/datasets/${dataset.id}/sheet-sync`, op.cookie, { action: 'inspect', url: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit' });
    check('opening a sheet without Sheets access asks to connect', inspect.status === 400 && inspect.json?.needsConnect === true, inspect.json);
    const otherPanel = await call('POST', `/api/datasets/${dataset.id}/sheet-sync`, other.cookie, { action: 'sync' });
    check('another workspace can’t sync this dataset', otherPanel.status === 403 || otherPanel.status === 404, otherPanel.status);
    const connect = await call('GET', `/api/gmail/connect?with=sheets&return=${encodeURIComponent(`/data/${dataset.id}?sheet=1`)}`, op.cookie);
    check('connect redirects to Google with the Sheets scope', connect.status >= 300 && connect.status < 400 && connect.location.includes('accounts.google.com') && decodeURIComponent(connect.location).includes('auth/spreadsheets') && decodeURIComponent(connect.location).includes('gmail.send'), connect.location.slice(0, 200));
    check('the return path is remembered', connect.setCookie.includes('mailflow_gmail_oauth_return'), connect.setCookie.slice(0, 200));
    const evil = await call('GET', `/api/gmail/connect?with=sheets&return=${encodeURIComponent('//evil.example.com')}`, op.cookie);
    check('an off-site return path is ignored', !/mailflow_gmail_oauth_return=%2F%2F|mailflow_gmail_oauth_return=\/\//.test(evil.setCookie), evil.setCookie.slice(0, 200));
    const plain = await call('GET', '/api/gmail/connect', op.cookie);
    check('plain Gmail connect does not ask for Sheets', !decodeURIComponent(plain.location).includes('auth/spreadsheets'), plain.location.slice(0, 200));

    console.log('\nAdmin automation settings');
    const asOp = await call('GET', '/api/admin/automation-settings', op.cookie);
    check('operators can’t open automation settings', asOp.status === 403, asOp.status);
    const put = await call('PUT', '/api/admin/automation-settings', op.cookie, { digest: { enabled: false } });
    check('operators can’t change them', put.status === 403, put.status);
  } finally {
    await removeFixtures();
    console.log('\nFixtures removed.');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await removeFixtures().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
