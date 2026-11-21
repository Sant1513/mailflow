import type { Prisma } from '@prisma/client';
import { getAiProvider } from '@/lib/ai/service';
import { controlDb } from '@/lib/system/serverState';
import { dailyFromModel, dayKey, sanitizeDaily, type Daily } from '@/lib/loading/clean';

/**
 * The loading screen's fresh lines: ONE AI call a day for everyone.
 *  - The result lives on the shared SystemState row (the control database both the cloud and the laptop use), so every
 *    server and every person gets the same lines and the AI is asked once, not once per server or per visitor.
 *  - A server that wants today's lines first claims the right to ask (an atomic update); the others wait a moment for
 *    the answer instead of asking too. A failed try can be repeated after 30 minutes.
 *  - The prompt is generic. It carries no user, company or recruiter data, and the answer is cleaned (lib/loading/clean.ts)
 *    before it is stored or shown. Without an AI key, or when anything fails, this returns null and the built-in lines are used.
 */
const RETRY_AFTER_MS = 30 * 60_000;
const WAIT_FOR_OTHER_MS = 25_000;

export const DAILY_PROMPT = `Write fresh loading-screen messages for the web app of an edtech placement team (an email platform: inbox, campaigns, quick sends, templates, PDF signing, bulk emails to recruiters, contacts, reports).
Tone: warm, witty, sometimes lightly sarcastic. Mix the edtech side (learners, upskilling, bootcamps, placements) with everyday work humour (spreadsheets, follow-ups, meetings).
Rules: each line is ONE short sentence under 80 characters. Tasteful: nothing about politics, religion, appearance or real people. No links, no email addresses, no "@", no HTML.
Reply with ONE JSON object and nothing else, in exactly this shape:
{"dashboard":[8 lines],"inbox":[8],"send":[8],"campaigns":[8],"templates":[8],"documents":[8],"automations":[6],"batches":[6],"data":[8],"contacts":[8],"suppressions":[6],"deliverability":[6],"performance":[6],"reports":[6],"history":[6],"approvals":[6],"recruiter":[8],"mailbox":[6],"settings":[6],"admin":[6],"general":[12],"thoughts":[20 short one-sentence thoughts for the day]}`;

let memo: Daily | null = null;

/** Pulls the JSON object out of the model's answer (it may wrap it in a code fence). */
export function parseModelJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function stored(date: string): Promise<Daily | null> {
  const row = await controlDb().systemState.findUnique({ where: { id: 'main' }, select: { loadingLines: true } });
  const d = sanitizeDaily(row?.loadingLines);
  return d && d.date === date ? d : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Today's fresh lines, or null (AI off, or not available right now). Never throws. */
export async function getDailyLines(now = Date.now()): Promise<Daily | null> {
  const date = dayKey(now);
  if (memo?.date === date) return memo;
  try {
    const have = await stored(date);
    if (have) return (memo = have);
    const provider = getAiProvider();
    if (!provider) return null;

    // Claim the day's single AI call. Only one server's update matches; a failed try frees the claim after 30 minutes.
    const db = controlDb();
    await db.systemState.upsert({ where: { id: 'main' }, create: { id: 'main' }, update: {} });
    const claimed = await db.systemState.updateMany({
      where: { id: 'main', OR: [{ loadingLinesTriedAt: null }, { loadingLinesTriedAt: { lt: new Date(now - RETRY_AFTER_MS) } }] },
      data: { loadingLinesTriedAt: new Date(now) },
    });
    if (claimed.count === 0) {
      // Another server is asking (or asked a moment ago): wait briefly for its answer.
      for (let waited = 0; waited < WAIT_FOR_OTHER_MS; waited += 2000) {
        await sleep(2000);
        const d = await stored(date);
        if (d) return (memo = d);
      }
      return null;
    }

    const result = await provider.generateText(DAILY_PROMPT, { maxOutputTokens: 6000 });
    const cleaned = dailyFromModel(parseModelJson(result.data), date);
    if (!cleaned) return null;
    await db.systemState.update({ where: { id: 'main' }, data: { loadingLines: cleaned as unknown as Prisma.InputJsonValue } });
    return (memo = cleaned);
  } catch (e) {
    console.error('loading lines: could not get today’s fresh lines', e instanceof Error ? e.message : e);
    return null;
  }
}

/** Test hook: forget the in-memory copy. */
export function resetDailyMemo() {
  memo = null;
}
