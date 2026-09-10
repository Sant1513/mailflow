/**
 * Phase 5 over real HTTP with a genuine NextAuth database session: inbox
 * page + API, conversation detail page + API, notes, tags, status, assign,
 * follow-up, read state. Uses a throwaway DISCONNECTED mailbox so Settings
 * never claims a Gmail connection that does not exist.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/smoke-test-inbox-http.ts
 */
import { prisma } from '../lib/db/client';
import { ingestInboundMessage } from '../lib/gmail/ingest';
import { parseGmailMessage } from '../lib/gmail/parseMessage';
import { EmailProvider as EmailProviderEnum } from '@prisma/client';
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const COOKIE_NAME = BASE.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}
const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function main() {
  console.log(`=== Phase 5 HTTP test against ${BASE} ===\n`);
  const user = await prisma.user.findFirstOrThrow({ include: { ownedWorkspaces: true }, orderBy: { createdAt: 'asc' } });
  const ws = user.ownedWorkspaces[0]!;
  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3600_000) } });
  const cookie = `${COOKIE_NAME}=${token}`;
  const stamp = Date.now();

  const req = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) },
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* HTML page */
    }
    return { status: r.status, json, text };
  };

  // Throwaway mailbox, explicitly DISCONNECTED. If a real one already exists
  // for this (workspace, user, provider), reuse it read-only instead.
  let createdTempAccount = false;
  let account = await prisma.emailProviderAccount.findUnique({
    where: { workspaceId_userId_provider: { workspaceId: ws.id, userId: user.id, provider: EmailProviderEnum.GMAIL } },
  });
  if (!account) {
    account = await prisma.emailProviderAccount.create({
      data: {
        organizationId: ws.organizationId,
        workspaceId: ws.id,
        userId: user.id,
        provider: EmailProviderEnum.GMAIL,
        emailAddress: `tmp-${stamp}@example.com`,
        status: 'DISCONNECTED',
      },
    });
    createdTempAccount = true;
  }

  const contact = await prisma.contact.create({
    data: { organizationId: ws.organizationId, workspaceId: ws.id, primaryEmail: `student-${stamp}@example.com`, name: 'Demo Student' },
  });

  console.log('-- Pages --');
  const inboxPage = await req('/inbox');
  check('GET /inbox renders for a signed-in user (200)', inboxPage.status === 200 && inboxPage.text.includes('Inbox'), inboxPage.status);
  const anon = await fetch(`${BASE}/inbox`, { redirect: 'manual' });
  check('GET /inbox redirects when signed out', anon.status === 307 || anon.status === 302, anon.status);

  console.log('\n-- Inbox API --');
  const empty = await req('/api/inbox?filter=all');
  check('GET /api/inbox (200) with counts', empty.status === 200 && !!empty.json?.counts, empty.json);

  // Ingest a reply through the real path so the UI has something to show.
  const threadId = `t-${stamp}`;
  const r = await ingestInboundMessage(
    account,
    parseGmailMessage({
      id: `m-${stamp}`,
      threadId,
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'Hello from the demo student',
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: `Demo Student <${contact.primaryEmail}>` },
          { name: 'To', value: account.emailAddress },
          { name: 'Subject', value: 'Question about RPG' },
          { name: 'Message-ID', value: `<d-${stamp}@example.com>` },
          { name: 'Date', value: new Date().toUTCString() },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('Hello from the demo student') } },
          { mimeType: 'text/html', body: { data: b64url('<p>Hello from the demo student</p>') } },
        ],
      },
    })
  );
  check('ingested a demo reply', r.status === 'STORED', r);
  const convId = r.status === 'STORED' ? r.conversationId : '';

  const listed = await req('/api/inbox?filter=unread');
  check('unread filter lists the new conversation', !!listed.json?.conversations?.some((c: any) => c.id === convId), listed.json?.conversations?.length);
  const searched = await req(`/api/inbox?filter=all&q=${encodeURIComponent('demo student')}`);
  check('search by message text finds it (§64)', !!searched.json?.conversations?.some((c: any) => c.id === convId));

  console.log('\n-- Conversation --');
  const page = await req(`/inbox/${convId}`);
  check('GET /inbox/[id] renders (200)', page.status === 200, page.status);
  const detail = await req(`/api/conversations/${convId}`);
  check(
    'GET /api/conversations/[id] (200) with messages + members',
    detail.status === 200 && detail.json?.conversation?.messages?.length === 1 && Array.isArray(detail.json?.members),
    detail.status
  );

  const read = await req(`/api/conversations/${convId}/read`, { method: 'POST', body: '{}' });
  check('POST read clears unread (§52)', read.status === 200 && read.json?.unread === false, read.json);
  const afterRead = await prisma.conversation.findUniqueOrThrow({ where: { id: convId } });
  check('conversation.unread is now false in the DB', afterRead.unread === false);

  const note = await req(`/api/conversations/${convId}/notes`, { method: 'POST', body: JSON.stringify({ body: 'Checked with placement lead' }) });
  check('POST note (201) with author', note.status === 201 && !!note.json?.note?.author?.name, note.json);
  const msgCount = await prisma.conversationMessage.count({ where: { conversationId: convId } });
  check('a note is NOT a message — cannot be sent (§58)', msgCount === 1, msgCount);

  const tag = await req(`/api/conversations/${convId}/tags`, { method: 'POST', body: JSON.stringify({ name: 'RPG' }) });
  check('POST tag (201)', tag.status === 201 && tag.json?.tag?.name === 'RPG', tag.json);
  const tagAgain = await req(`/api/conversations/${convId}/tags`, { method: 'POST', body: JSON.stringify({ name: 'RPG' }) });
  check('re-adding the same tag is idempotent', tagAgain.status === 201);
  const untag = await req(`/api/conversations/${convId}/tags`, { method: 'DELETE', body: JSON.stringify({ name: 'RPG' }) });
  check('DELETE tag (200)', untag.status === 200);

  const st = await req(`/api/conversations/${convId}`, { method: 'PATCH', body: JSON.stringify({ status: 'IN_PROGRESS' }) });
  check('PATCH status (200)', st.status === 200 && st.json?.conversation?.status === 'IN_PROGRESS', st.json);
  const asg = await req(`/api/conversations/${convId}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: user.id }) });
  check('PATCH assign to self (200)', asg.status === 200 && asg.json?.conversation?.assigneeId === user.id, asg.json);
  const badAsg = await req(`/api/conversations/${convId}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: 'nope' }) });
  check('assigning an unknown user is rejected (400)', badAsg.status === 400, badAsg.status);

  const fu = await req(`/api/conversations/${convId}/follow-up`, {
    method: 'POST',
    body: JSON.stringify({ dueDate: new Date(Date.now() + 86_400_000).toISOString(), note: 'Check RPG' }),
  });
  check('POST follow-up (201)', fu.status === 201 && !!fu.json?.followUp?.id, fu.json);
  const done = await req(`/api/conversations/${convId}/follow-up`, {
    method: 'PATCH',
    body: JSON.stringify({ followUpId: fu.json?.followUp?.id, completed: true }),
  });
  check('PATCH follow-up complete (200)', done.status === 200 && done.json?.followUp?.completed === true, done.json);

  const audits = await prisma.auditLog.count({
    where: { targetId: convId, action: { in: ['CONVERSATION_STATUS_CHANGE', 'CONVERSATION_ASSIGN', 'CONVERSATION_NOTE', 'CONVERSATION_TAG_ADD'] } },
  });
  check('status/assign/note/tag are audited (§95)', audits >= 4, audits);

  const replyNoGmail = await req(`/api/conversations/${convId}/reply`, { method: 'POST', body: JSON.stringify({ html: '<p>hi</p>' }) });
  if (account.status === 'CONNECTED') {
    // A real mailbox is connected for this user: the conversation's thread id
    // is fabricated, so Gmail must reject it and nothing may be recorded as sent.
    const sentRows = await prisma.conversationMessage.count({ where: { conversationId: convId, direction: 'OUTBOUND', status: 'SENT' } });
    check('reply to a fabricated thread is rejected by Gmail, not faked (non-2xx, nothing stored)', replyNoGmail.status >= 400 && sentRows === 0, replyNoGmail.json);
  } else {
    check('reply without a CONNECTED mailbox is refused, not faked (400)', replyNoGmail.status === 400, replyNoGmail.json);
  }

  const timeline = await req(`/api/contacts/${contact.id}`);
  check(
    'contact timeline has entries (§61)',
    timeline.status === 200 && (timeline.json?.contact?.recipientHistory?.length ?? 0) >= 3,
    timeline.json?.contact?.recipientHistory?.length
  );

  console.log('\n-- Cleanup --');
  await prisma.notification.deleteMany({ where: { workspaceId: ws.id, link: `/inbox/${convId}` } });
  await prisma.followUp.deleteMany({ where: { conversationId: convId } });
  await prisma.conversationTag.deleteMany({ where: { conversationId: convId } });
  await prisma.tag.deleteMany({ where: { workspaceId: ws.id, name: 'RPG' } });
  await prisma.internalNote.deleteMany({ where: { conversationId: convId } });
  await prisma.conversationMessage.deleteMany({ where: { conversationId: convId } });
  await prisma.conversation.delete({ where: { id: convId } });
  await prisma.recipientHistory.deleteMany({ where: { contactId: contact.id } });
  await prisma.contact.delete({ where: { id: contact.id } });
  if (createdTempAccount) await prisma.emailProviderAccount.delete({ where: { id: account.id } });
  await prisma.auditLog.deleteMany({ where: { targetId: convId } });
  await prisma.session.deleteMany({ where: { sessionToken: token } });
  console.log('  ✓ all rows removed');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error('CRASHED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
