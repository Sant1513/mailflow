/**
 * Phase 7 smoke test — §75–§83 AI assistant, against a live server AND the
 * real Gemini API (uses GEMINI_API_KEY from the environment; no mocks).
 *
 * Fixture users/sessions are throwaway (same approach as the other smoke
 * scripts) and deleted at the end. Every AI call is a real request, so the
 * run consumes a handful of Gemini requests and logs real AiUsage rows,
 * which are also deleted.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/smoke-test-ai.ts
 */
import 'dotenv/config';
import { prisma } from '../lib/db/client';
import { signViewAs } from '../lib/auth/viewAs';
import { Role, EmailProvider as EmailProviderEnum } from '@prisma/client';
import crypto from 'node:crypto';

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
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '');
  }
}

async function createSessionFor(userId: string) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { sessionToken, userId, expires: new Date(Date.now() + 3600_000) } });
  return `${SESSION_COOKIE}=${sessionToken}`;
}

async function ai(cookie: string | null, body: unknown) {
  const res = await fetch(`${BASE_URL}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

async function main() {
  console.log(`=== MailFlow Phase 7 AI smoke test against ${BASE_URL} (real Gemini) ===\n`);
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set in this environment');
  const stamp = Date.now();

  const org = await prisma.organization.upsert({
    where: { allowedDomain: 'masaischool.com' },
    update: {},
    create: { name: 'Masai School', allowedDomain: 'masaischool.com' },
  });
  const user = await prisma.user.create({
    data: { organizationId: org.id, googleId: `p7-${stamp}`, email: `p7-op+${stamp}@masaischool.com`, name: 'Abhishesh Kumar', role: Role.OPERATOR },
  });
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: user.id, name: 'P7 WS' } });
  const other = await prisma.user.create({
    data: { organizationId: org.id, googleId: `p7-other-${stamp}`, email: `p7-other+${stamp}@masaischool.com`, name: 'Other Person', role: Role.OPERATOR },
  });
  const otherWs = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: other.id, name: 'P7 Other WS' } });
  const admin = await prisma.user.create({
    data: { organizationId: org.id, googleId: `p7-admin-${stamp}`, email: `p7-admin+${stamp}@masaischool.com`, name: 'P7 Admin', role: Role.SUPER_ADMIN },
  });
  const adminWs = await prisma.workspace.create({ data: { organizationId: org.id, ownerId: admin.id, name: 'P7 Admin WS' } });

  const account = await prisma.emailProviderAccount.create({
    data: { organizationId: org.id, workspaceId: ws.id, userId: user.id, provider: EmailProviderEnum.GMAIL, emailAddress: `p7-${stamp}@example.com`, status: 'DISCONNECTED' },
  });
  const contact = await prisma.contact.create({
    data: { organizationId: org.id, workspaceId: ws.id, primaryEmail: `rahul.p7+${stamp}@example.com`, name: 'Rahul Sharma' },
  });
  const conversation = await prisma.conversation.create({
    data: {
      organizationId: org.id,
      workspaceId: ws.id,
      ownerId: user.id,
      contactId: contact.id,
      recipientEmail: contact.primaryEmail,
      subject: 'RPG completion — action required',
      emailProviderAccountId: account.id,
      gmailThreadId: `p7-thread-${stamp}`,
      messageCount: 2,
      firstMessageAt: new Date(stamp - 86_400_000),
      lastMessageAt: new Date(stamp),
    },
  });
  const outbound = await prisma.conversationMessage.create({
    data: {
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      classification: 'UNKNOWN',
      senderEmail: account.emailAddress,
      senderName: user.name,
      recipientEmail: contact.primaryEmail,
      subject: conversation.subject,
      plainTextBody: 'Hi Rahul,\n\nPlease complete your RPG (Readiness Program) by Friday, 12 September, so we can move you to the placement pool.\n\nRegards,\nAbhishesh',
      sentAt: new Date(stamp - 86_400_000),
      status: 'SENT',
    },
  });
  const inbound = await prisma.conversationMessage.create({
    data: {
      conversationId: conversation.id,
      direction: 'INBOUND',
      classification: 'HUMAN_REPLY',
      classificationConfidence: 0.7,
      senderEmail: contact.primaryEmail,
      senderName: 'Rahul Sharma',
      recipientEmail: account.emailAddress,
      subject: 'Re: RPG completion — action required',
      plainTextBody: 'Hi Abhishesh,\n\nDone — I completed the RPG yesterday and my score is 82. Can you confirm my placement status will be updated? My number is +91 98765 43210 if you need to call.\n\nThanks,\nRahul\n\nOn Thu, Abhishesh wrote:\n> Please complete your RPG',
      receivedAt: new Date(stamp),
      status: 'RECEIVED',
    },
  });

  const cookie = await createSessionFor(user.id);
  const otherCookie = await createSessionFor(other.id);
  const adminCookie = await createSessionFor(admin.id);
  const usageBefore = await prisma.aiUsage.count({ where: { userId: user.id } });

  try {
    console.log('-- policy --');
    let r = await ai(null, { action: 'generate_email', brief: 'test' });
    check('anonymous is refused (401)', r.status === 401, r.json);
    r = await ai(cookie, { action: 'nope' });
    check('unknown action is a validation error (400)', r.status === 400, r.json);
    r = await ai(otherCookie, { action: 'suggest_reply', conversationId: conversation.id });
    check("another workspace's conversation is 404, not leaked", r.status === 404, r.json);
    const st = await fetch(`${BASE_URL}/api/ai`, { headers: { Cookie: cookie } }).then((x) => x.json());
    check('GET reports enabled + model + usage counters', st.enabled === true && typeof st.model === 'string' && typeof st.usage?.userLimit === 'number', st);

    console.log('-- §78 suggest reply (real Gemini) --');
    r = await ai(cookie, { action: 'suggest_reply', conversationId: conversation.id });
    check('suggest_reply ok', r.status === 200 && r.json?.ok === true, r.json);
    const draft: string = r.json?.data?.text ?? '';
    check('draft greets Rahul and signs off as the sender', /Hi Rahul/.test(draft) && /Abhishesh/.test(draft), draft);
    check('draft does not contain the redacted phone number', !draft.includes('98765'), draft);
    check('usage reports tokens and today count', r.json?.usage?.totalTokens > 0 && r.json?.usage?.userToday === 1, r.json?.usage);
    r = await ai(cookie, { action: 'suggest_reply', conversationId: conversation.id, style: 'shorter' });
    check('shorter style is accepted', r.status === 200 && r.json?.ok === true && (r.json.data.text.length < draft.length + 200), { len: r.json?.data?.text?.length, draftLen: draft.length });

    console.log('-- §79 summary --');
    r = await ai(cookie, { action: 'summarize_conversation', conversationId: conversation.id });
    check('summary ok with next action', r.json?.ok === true && r.json.data.summary.length > 20 && r.json.data.suggestedNextAction.length > 5, r.json);
    check('summary mentions RPG completion', /RPG|completed|completion/i.test(r.json?.data?.summary ?? ''), r.json?.data?.summary);
    check('suggested status is one of the allowed values or null', [null, 'OPEN', 'IN_PROGRESS', 'WAITING_FOR_STUDENT', 'RESOLVED'].includes(r.json?.data?.suggestedStatus), r.json?.data);
    const statusAfter = await prisma.conversation.findUnique({ where: { id: conversation.id }, select: { status: true } });
    check('summary did NOT change the conversation status (human must confirm)', statusAfter?.status === 'OPEN', statusAfter);

    console.log('-- §80 classify --');
    r = await ai(cookie, { action: 'classify_reply', conversationId: conversation.id });
    check('classify ok', r.json?.ok === true, r.json);
    check('intent is COMPLETED (student said done)', r.json?.data?.intent === 'COMPLETED', r.json?.data);
    check('confidence is 0–1', r.json?.data?.confidence >= 0 && r.json?.data?.confidence <= 1, r.json?.data);
    const msg = await prisma.conversationMessage.findUnique({ where: { id: inbound.id }, select: { aiIntent: true, aiIntentConfidence: true, classification: true } });
    check('intent stored on the message with confidence', msg?.aiIntent === r.json?.data?.intent && typeof msg?.aiIntentConfidence === 'number', msg);
    check('header-first classification untouched', msg?.classification === 'HUMAN_REPLY', msg);

    console.log('-- §77 generate / improve / subjects / personalisation --');
    r = await ai(cookie, { action: 'generate_email', brief: 'Professional reminder for students who have not completed RPG, deadline is {{Deadline}}', tone: 'professional', variables: ['Name', 'Deadline', 'Code'] });
    check('generate_email ok with subject/html/plainText', r.json?.ok === true && r.json.data.subject && r.json.data.html.includes('<') && r.json.data.plainText.length > 40, r.json);
    check('generated copy uses only allowed variables', (r.json?.data?.usedVariables ?? []).every((v: string) => ['Name', 'Deadline', 'Code'].includes(v)), r.json?.data?.usedVariables);
    const foreignVars = (r.json?.data?.html ?? '').match(/\{\{\s*([A-Za-z0-9_ ]+)\s*\}\}/g) ?? [];
    check('no invented variables in the HTML', foreignVars.every((m: string) => ['Name', 'Deadline', 'Code'].includes(m.replace(/[{}\s]/g, ''))), foreignVars);

    const long = '<p>Hi {{Name}},</p><p>This is a gentle reminder that the Readiness Program (RPG) for your batch needs to be completed. The RPG is an important requirement and completing it on time ensures that you remain eligible for the placement process. Please make sure that all the modules are finished and submitted through the portal before the deadline mentioned below, so that our team can process your placement readiness without any delay.</p><p>Deadline: {{Deadline}}</p><p>Regards,<br/>Abhishesh</p>';
    r = await ai(cookie, { action: 'improve_text', text: long, mode: 'shorten', format: 'html', variables: ['Name', 'Deadline'] });
    check('shorten ok and shorter', r.json?.ok === true && r.json.data.text.length < long.length, { before: long.length, after: r.json?.data?.text?.length });
    check('shorten preserved {{Name}} and {{Deadline}}', /\{\{Name\}\}/.test(r.json?.data?.text ?? '') && /\{\{Deadline\}\}/.test(r.json?.data?.text ?? ''), r.json?.data?.text);
    r = await ai(cookie, { action: 'improve_text', text: "their is a error in you're submission, pls fix", mode: 'grammar', format: 'text', variables: [] });
    check('grammar fix ok', r.json?.ok === true && !/their is/.test(r.json.data.text), r.json?.data);

    r = await ai(cookie, { action: 'subject_lines', brief: 'RPG completion reminder', variables: ['Deadline'], count: 4 });
    check('subject_lines returns 4 short lines', r.json?.ok === true && r.json.data.length === 4 && r.json.data.every((s: string) => s.length <= 80), r.json?.data);

    r = await ai(cookie, { action: 'check_personalization', subject: 'Reminder', body: '<p>Dear student, please complete the RPG by {{Deadline}}. Your code is {{Code}}.</p>', variables: ['Name', 'Deadline'] });
    check('personalisation check ok with a score', r.json?.ok === true && r.json.data.score >= 0 && r.json.data.score <= 100, r.json);
    check('missing variables computed locally, not by the AI', JSON.stringify(r.json?.data?.missingVariables) === JSON.stringify(['Code']), r.json?.data);

    console.log('-- §9 view-as is read-only for AI annotations --');
    const viewing = `${adminCookie}; mailflow.view-as=${signViewAs(ws.id)}`;
    await prisma.conversationMessage.update({ where: { id: inbound.id }, data: { aiIntent: null, aiIntentConfidence: null, aiIntentReason: null } });
    // The free tier allows a burst of ~10 requests a minute; after the calls above the
    // provider may answer 429. The graceful RATE_LIMITED outcome is itself the §82
    // behaviour under test, so wait once, then accept either result.
    r = await ai(viewing, { action: 'classify_reply', conversationId: conversation.id });
    if (r.json?.code === 'RATE_LIMITED') {
      console.log('    (provider 429 — waiting 30s and retrying once)');
      await new Promise((res) => setTimeout(res, 30_000));
      r = await ai(viewing, { action: 'classify_reply', conversationId: conversation.id });
    }
    check('super admin viewing-as can classify (read), or is gracefully rate-limited', r.status === 200 && (r.json?.ok === true || r.json?.code === 'RATE_LIMITED'), r.json);
    const afterView = await prisma.conversationMessage.findUnique({ where: { id: inbound.id }, select: { aiIntent: true } });
    check('…but nothing is written while viewing', afterView?.aiIntent === null, afterView);

    console.log('-- §81 usage log --');
    const rows = await prisma.aiUsage.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    check('every call logged with feature, success, tokens and latency', rows.length - usageBefore >= 9 && rows.every((x) => x.feature && x.tokensUsed !== null && x.latencyMs !== null && x.success), { count: rows.length, sample: rows[0] });
    check('features logged span reply, summary, classify, generate, improve, subjects, personalisation', ['suggest_reply', 'summarize_conversation', 'classify_reply', 'generate_email', 'improve_text', 'subject_lines', 'check_personalization'].every((f) => rows.some((x) => x.feature === f)), rows.map((x) => x.feature));
    const stAfter = await fetch(`${BASE_URL}/api/ai`, { headers: { Cookie: cookie } }).then((x) => x.json());
    check('GET usage today matches the log', stAfter.usage.userToday === rows.length, stAfter.usage);

    console.log('-- pages render the AI panels --');
    const page = await fetch(`${BASE_URL}/inbox/${conversation.id}`, { headers: { Cookie: cookie }, redirect: 'manual' });
    check('conversation page renders (200)', page.status === 200, page.status);
    const settings = await fetch(`${BASE_URL}/admin/system-settings`, { headers: { Cookie: adminCookie }, redirect: 'manual' }).then((x) => x.text());
    check('system settings shows AI provider, limits and usage', settings.includes('AI provider') && settings.includes('AI daily limits') && settings.includes('AI usage today'), settings.length);
  } finally {
    console.log('\n-- cleanup --');
    await prisma.aiUsage.deleteMany({ where: { userId: { in: [user.id, other.id, admin.id] } } });
    await prisma.conversationMessage.deleteMany({ where: { id: { in: [outbound.id, inbound.id] } } });
    await prisma.recipientHistory.deleteMany({ where: { contactId: contact.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.contact.deleteMany({ where: { id: contact.id } });
    await prisma.emailProviderAccount.deleteMany({ where: { id: account.id } });
    await prisma.session.deleteMany({ where: { userId: { in: [user.id, other.id, admin.id] } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [user.id, other.id, admin.id] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [ws.id, otherWs.id, adminWs.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id, admin.id] } } });
    await prisma.$disconnect();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
