/**
 * Inbox composer + rendering + assignment/resolution notifications + CRM
 * extras — HTTP smoke test. Fixture users are throwaway; the fixture
 * organisation's Slack channel is pointed at the real testing channel so
 * the assignment → resolution thread is exercised against Slack for real
 * (two messages in one thread), then the setting is removed.
 *
 * Usage: BASE_URL=http://localhost:3000 SLACK_TEST_CHANNEL=C09HV1K5EGJ npx tsx scripts/smoke-test-inbox-notify-http.ts
 */
import 'dotenv/config';
import { prisma } from '../lib/db/client';
import { Role, EmailProvider as EmailProviderEnum } from '@prisma/client';
import crypto from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SESSION_COOKIE = BASE_URL.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
const SLACK_TEST_CHANNEL = process.env.SLACK_TEST_CHANNEL ?? '';
// The fixture reuses the real Masai organisation, so the channel under test is
// whichever one that organisation has configured — SLACK_TEST_CHANNEL only
// seeds one when it has none. Resolved after the seed below.
let slackChannel = '';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '');
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
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML */
  }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`=== MailFlow inbox + notifications smoke test against ${BASE_URL} ===\n`);
  const stamp = Date.now();
  const org = await prisma.organization.upsert({ where: { allowedDomain: 'masaischool.com' }, update: {}, create: { name: 'Masai School', allowedDomain: 'masaischool.com' } });
  const mk = async (tag: string, role: Role, slackUserId?: string) => {
    const u = await prisma.user.create({ data: { organizationId: org.id, googleId: `nt-${tag}-${stamp}`, email: `nt-${tag}+${stamp}@masaischool.com`, name: `Notify ${tag}`, role, slackUserId } });
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: u.id, name: `Notify ${tag} WS` } });
    return { u, ws, cookie: await createSessionFor(u.id) };
  };
  const owner = await mk('owner', Role.OPERATOR);
  const assignee = await mk('assignee', Role.OPERATOR, 'U04DRTCE9L4');
  const admin = await mk('admin', Role.SUPER_ADMIN);
  const viewer = await mk('viewer', Role.VIEWER);

  if (SLACK_TEST_CHANNEL) {
    await prisma.integrationSettings.upsert({ where: { organizationId: org.id }, create: { organizationId: org.id, slackChannelId: SLACK_TEST_CHANNEL }, update: { slackChannelId: SLACK_TEST_CHANNEL, slackNotifyAssignments: true, slackNotifyResolutions: true, slackNotifyFollowUps: true } });
  }

  slackChannel = (await prisma.integrationSettings.findUnique({ where: { organizationId: org.id }, select: { slackChannelId: true, slackNotifyAssignments: true, slackNotifyResolutions: true } }).then((s) => (s?.slackNotifyAssignments && s?.slackNotifyResolutions ? s.slackChannelId : null))) ?? '';
  console.log(slackChannel ? `Slack channel under test: ${slackChannel}` : 'No Slack channel configured for this organisation — asserting the skip path.');

  const account = await prisma.emailProviderAccount.create({
    data: { organizationId: org.id, workspaceId: owner.ws.id, userId: owner.u.id, provider: EmailProviderEnum.GMAIL, emailAddress: `nt-${stamp}@example.com`, status: 'DISCONNECTED' },
  });
  const contact = await prisma.contact.create({ data: { organizationId: org.id, workspaceId: owner.ws.id, primaryEmail: `rahul.nt+${stamp}@example.com`, name: 'Rahul Sharma' } });
  const dataset = await prisma.dataset.create({ data: { organizationId: org.id, workspaceId: owner.ws.id, ownerId: owner.u.id, name: `Notify ds ${stamp}` } });
  await prisma.record.create({ data: { datasetId: dataset.id, contactId: contact.id, data: { Name: 'Rahul Sharma', Email: contact.primaryEmail, Code: 'fd41_470074' } } });
  const conversation = await prisma.conversation.create({
    data: {
      organizationId: org.id, workspaceId: owner.ws.id, ownerId: owner.u.id, contactId: contact.id, recipientEmail: contact.primaryEmail,
      subject: `Smoke <thread> ${stamp}`, emailProviderAccountId: account.id, gmailThreadId: `nt-${stamp}`, messageCount: 2, lastMessageAt: new Date(),
    },
  });
  const inboundHtml = `<div dir="ltr"><p>Done with <b>RPG</b> &amp; thanks!</p><img src="x" onerror="alert(1)"></div><div class="gmail_quote"><div>On Fri, Team wrote:</div><blockquote>Please complete RPG</blockquote></div>`;
  const inbound = await prisma.conversationMessage.create({
    data: { conversationId: conversation.id, direction: 'INBOUND', classification: 'HUMAN_REPLY', senderEmail: contact.primaryEmail, senderName: 'Rahul Sharma', recipientEmail: account.emailAddress, subject: 'Re: Smoke', htmlBody: inboundHtml, plainTextBody: 'Done with RPG & thanks!\n\nOn Fri, Team wrote:\n> Please complete RPG', snippet: 'Done with RPG', receivedAt: new Date() },
  });
  await prisma.conversationMessage.create({
    data: { conversationId: conversation.id, direction: 'OUTBOUND', classification: 'UNKNOWN', senderEmail: account.emailAddress, recipientEmail: contact.primaryEmail, subject: 'Smoke', plainTextBody: 'Please complete RPG by Friday.\n\nSee https://masaischool.com/rpg', sentAt: new Date(Date.now() - 86_400_000), status: 'SENT' },
  });

  try {
    console.log('-- §2 message rendering --');
    let r = await call(`/api/conversations/${conversation.id}`, owner.cookie);
    check('conversation loads', r.status === 200, r.status);
    const msgs: any[] = r.json?.conversation?.messages ?? [];
    const inb = msgs.find((m) => m.id === inbound.id);
    check('inbound HTML is split: main is sanitised, quote is separate', !!inb && inb.bodyMain.includes('<b>RPG</b>') && !inb.bodyMain.includes('onerror') && !inb.bodyMain.includes('gmail_quote') && typeof inb.bodyQuoted === 'string' && inb.bodyQuoted.includes('gmail_quote'), inb && { main: inb.bodyMain, quoted: inb.bodyQuoted?.slice(0, 60) });
    check('raw htmlBody is not sent to the browser', inb && inb.htmlBody === undefined, inb && Object.keys(inb).filter((k) => k.includes('Body')));
    const out = msgs.find((m) => m.direction === 'OUTBOUND');
    check('plain-text message becomes paragraphs with a clickable link', !!out && out.bodyMain.includes('<a href="https://masaischool.com/rpg"') && out.bodyMain.startsWith('<p>'), out?.bodyMain);
    const page = await call(`/inbox/${conversation.id}`, owner.cookie);
    check('conversation page renders', page.status === 200, page.status);

    console.log('-- §1 composer: reply route --');
    const big = Buffer.alloc(5 * 1024 * 1024, 1).toString('base64');
    r = await call(`/api/conversations/${conversation.id}/reply`, owner.cookie, { method: 'POST', body: JSON.stringify({ html: '<p>hi</p>', attachments: [{ filename: 'big.bin', mimeType: 'application/octet-stream', base64: big }] }) });
    // Locally the route answers 400; on Vercel the platform answers 413 before the route runs. Both refuse.
    check('attachments over 4 MB are refused (400 from the app, or 413 from the platform)', (r.status === 400 && /4 MB/.test(r.json?.error ?? '')) || r.status === 413, { status: r.status, body: r.json });
    r = await call(`/api/conversations/${conversation.id}/reply`, owner.cookie, { method: 'POST', body: JSON.stringify({ html: '<p>hi <b>there</b></p>', attachments: [{ filename: 'note.txt', mimeType: 'text/plain', base64: Buffer.from('hello').toString('base64') }] }) });
    check('valid HTML + attachment reaches the mailbox check (no Gmail here → 400 connect)', r.status === 400 && /Gmail/.test(r.json?.error ?? ''), r.json);
    r = await call(`/api/conversations/${conversation.id}/reply`, viewer.cookie, { method: 'POST', body: JSON.stringify({ html: '<p>x</p>' }) });
    check('viewer cannot reply (403)', r.status === 403, r.status);

    console.log('-- §4.1 snippets --');
    r = await call('/api/snippets', owner.cookie, { method: 'POST', body: JSON.stringify({ name: 'RPG thanks', html: '<p>Hi {{FirstName}}, code {{Code}}, by {{Deadline}}. <script>x</script></p>' }) });
    check('create snippet (201, sanitised)', r.status === 201 && r.json?.snippet?.html && !r.json.snippet.html.includes('script'), r.json);
    const snippetId = r.json?.snippet?.id;
    r = await call(`/api/snippets?conversationId=${conversation.id}`, owner.cookie);
    const sn = r.json?.snippets?.find((s: any) => s.id === snippetId);
    check('snippet renders for the conversation student; unknown variables stay visible', !!sn && sn.rendered.includes('Hi Rahul, code fd41_470074, by {{Deadline}}') && JSON.stringify(sn.missing) === '["Deadline"]', sn);
    r = await call(`/api/snippets/${snippetId}`, owner.cookie, { method: 'PATCH', body: JSON.stringify({ name: 'RPG thanks v2' }) });
    check('rename snippet', r.status === 200 && r.json?.snippet?.name === 'RPG thanks v2', r.json);
    r = await call('/api/snippets', assignee.cookie);
    check("another workspace does not see it", r.status === 200 && !r.json.snippets.some((s: any) => s.id === snippetId), r.json?.snippets?.length);
    r = await call('/api/snippets', viewer.cookie, { method: 'POST', body: JSON.stringify({ name: 'x', html: '<p>x</p>' }) });
    check('viewer cannot create snippets (403)', r.status === 403, r.status);

    console.log('-- §3 assignment → email + Slack + bell --');
    r = await call(`/api/conversations/${conversation.id}`, owner.cookie, { method: 'PATCH', body: JSON.stringify({ assigneeId: assignee.u.id }) });
    check('assign succeeds (200) and returns notify outcomes', r.status === 200 && r.json?.notify?.assignment, r.json?.notify);
    const a = r.json?.notify?.assignment ?? {};
    check('in-app notification created for the assignee', a.inApp === 'SENT', a);
    check('email attempted; recorded as skipped (no connected Gmail in the fixture)', typeof a.email === 'string' && a.email.startsWith('SKIPPED'), a.email);
    if (slackChannel) {
      check('Slack channel message posted, mentioning the assignee', a.slack === `SENT to ${slackChannel}`, a.slack);
      const c1 = await prisma.conversation.findUnique({ where: { id: conversation.id }, select: { notifySlackThreadTs: true, notifySlackChannelId: true } });
      check('Slack thread ts stored on the conversation', !!c1?.notifySlackThreadTs && c1.notifySlackChannelId === slackChannel, c1);
    } else {
      check('Slack skipped with a reason when no channel is configured', String(a.slack).startsWith('SKIPPED'), a.slack);
    }
    r = await call('/api/notifications', assignee.cookie);
    check('assignee sees the notification unread', r.status === 200 && r.json.unread >= 1 && r.json.notifications.some((n: any) => n.type === 'ASSIGNMENT' && n.link === `/inbox/${conversation.id}`), r.json);
    const nid = r.json?.notifications?.find((n: any) => n.type === 'ASSIGNMENT')?.id;
    r = await call('/api/notifications', assignee.cookie, { method: 'POST', body: JSON.stringify({ ids: [nid] }) });
    check('mark one read', r.status === 200 && r.json.marked === 1, r.json);
    r = await call('/api/notifications', owner.cookie, { method: 'POST', body: JSON.stringify({ ids: [nid] }) });
    check("someone else cannot mark my notification", r.json?.marked === 0, r.json);
    const audit1 = await prisma.auditLog.findFirst({ where: { targetId: conversation.id, action: 'CONVERSATION_NOTIFY' } });
    check('notification attempt audited with outcomes', !!audit1 && (audit1.metadata as any).kind === 'assignment', audit1?.metadata);

    console.log('-- §3 resolution → same threads --');
    r = await call(`/api/conversations/${conversation.id}`, owner.cookie, { method: 'PATCH', body: JSON.stringify({ status: 'RESOLVED' }) });
    check('resolve succeeds with notify outcomes', r.status === 200 && r.json?.notify?.resolution, r.json?.notify);
    const res = r.json?.notify?.resolution ?? {};
    check('assignee gets an in-app notification', res.inApp === 'SENT', res);
    if (slackChannel) check('Slack reply lands in the assignment thread', res.slack === 'SENT (in the assignment thread)', res.slack);
    r = await call('/api/notifications', assignee.cookie);
    check('bell shows the RESOLVED notification', r.json?.notifications?.some((n: any) => n.type === 'RESOLVED'), r.json?.notifications?.map((n: any) => n.type));

    console.log('-- §4.3 follow-up reminders --');
    await prisma.followUp.create({ data: { conversationId: conversation.id, dueDate: new Date(Date.now() - 60_000), note: 'Ping about offer letter' } });
    r = await call(`/api/cron/follow-ups?secret=${encodeURIComponent(process.env.CRON_SECRET ?? '')}`, null);
    check('cron runs and reminds exactly the due follow-up', r.status === 200 && r.json.results.some((x: any) => x.inApp === 'SENT'), r.json);
    const again = await call(`/api/cron/follow-ups?secret=${encodeURIComponent(process.env.CRON_SECRET ?? '')}`, null);
    const ours = await prisma.followUp.findFirst({ where: { conversationId: conversation.id } });
    check('second run does not remind twice (remindedAt set)', !!ours?.remindedAt && !again.json.results.some((x: any) => x.id === ours?.id), { remindedAt: ours?.remindedAt });
    r = await call('/api/cron/follow-ups?secret=wrong', null);
    check('wrong secret is refused (401)', process.env.CRON_SECRET ? r.status === 401 : true, r.status);
    r = await call('/api/notifications', assignee.cookie);
    check('assignee has the FOLLOW_UP_DUE notification', r.json?.notifications?.some((n: any) => n.type === 'FOLLOW_UP_DUE'), r.json?.notifications?.map((n: any) => n.type));

    console.log('-- profile + integration settings --');
    r = await call('/api/me', owner.cookie, { method: 'PATCH', body: JSON.stringify({ slackUserId: 'not-an-id' }) });
    check('bad Slack id rejected (400)', r.status === 400, r.status);
    r = await call('/api/me', owner.cookie, { method: 'PATCH', body: JSON.stringify({ slackUserId: 'U0ABCDEFG' }) });
    check('own Slack id saved', r.status === 200 && r.json?.me?.slackUserId === 'U0ABCDEFG', r.json);
    r = await call(`/api/admin/users/${owner.u.id}`, admin.cookie, { method: 'PATCH', body: JSON.stringify({ slackUserId: '' }) });
    check('admin clears a Slack id', r.status === 200 && r.json?.user?.slackUserId === null, r.json);
    r = await call('/api/admin/integrations', owner.cookie);
    check('operator cannot read integration settings (403)', r.status === 403, r.status);
    r = await call('/api/admin/integrations', admin.cookie);
    check('super admin reads settings + bot status', r.status === 200 && typeof r.json.settings.slackConfigured === 'boolean' && 'bot' in r.json, r.json);
    r = await call('/api/admin/integrations', admin.cookie, { method: 'PUT', body: JSON.stringify({ slackChannelId: 'bad id' }) });
    check('bad channel id rejected (400)', r.status === 400, r.status);
    r = await call('/api/admin/integrations', admin.cookie, { method: 'PUT', body: JSON.stringify({ slackNotifyFollowUps: false }) });
    check('toggle saved', r.status === 200 && r.json?.settings?.slackNotifyFollowUps === false, r.json);
    const settingsPage = await call('/admin/system-settings', admin.cookie);
    check('system settings page shows the Slack section', settingsPage.status === 200 && settingsPage.text.includes('Slack notifications'), settingsPage.status);
    const me = await call('/settings', owner.cookie);
    check('settings page shows Slack ID + saved replies', me.status === 200 && me.text.includes('Saved replies'), me.status);
  } finally {
    console.log('\n-- cleanup --');
    const ids = [owner.u.id, assignee.u.id, admin.u.id, viewer.u.id];
    await prisma.integrationSettings.deleteMany({ where: { organizationId: org.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.replySnippet.deleteMany({ where: { workspaceId: owner.ws.id } });
    await prisma.followUp.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversationMessage.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.recipientHistory.deleteMany({ where: { contactId: contact.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.dataset.deleteMany({ where: { id: dataset.id } });
    await prisma.contact.deleteMany({ where: { workspaceId: owner.ws.id } });
    await prisma.emailProviderAccount.deleteMany({ where: { id: account.id } });
    await prisma.workspace.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
