/**
 * Minimal Slack Web API client (fetch only). The bot token comes from
 * SLACK_BOT_TOKEN and never leaves the server. Every call returns a plain
 * result instead of throwing, so notification code can record the outcome
 * and move on (§82 spirit: an integration being down never blocks work).
 */

export interface SlackResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface PostMessageInput {
  channel: string;
  text: string;
  /** Slack Block Kit blocks; `text` stays as the notification fallback. */
  blocks?: unknown[];
  threadTs?: string | null;
  /** Also show a threaded reply in the channel. */
  broadcast?: boolean;
}

export interface PostedMessage {
  ts: string;
  channel: string;
}

export function slackConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SLACK_BOT_TOKEN?.trim());
}

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000
  ) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): SlackClient | null {
    const token = env.SLACK_BOT_TOKEN?.trim();
    return token ? new SlackClient(token) : null;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<SlackResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json()) as { ok: boolean; error?: string } & T;
      if (!json.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
      return { ok: true, data: json };
    } catch (err) {
      return { ok: false, error: (err as Error)?.name === 'AbortError' ? 'timeout' : ((err as Error)?.message ?? 'network error') };
    } finally {
      clearTimeout(timer);
    }
  }

  async authTest(): Promise<SlackResult<{ user: string; team: string; user_id: string }>> {
    return this.call('auth.test', {});
  }

  async postMessage(input: PostMessageInput): Promise<SlackResult<PostedMessage>> {
    const r = await this.call<{ ts: string; channel: string }>('chat.postMessage', {
      channel: input.channel,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.threadTs && input.broadcast ? { reply_broadcast: true } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!r.ok) return r;
    return { ok: true, data: { ts: r.data!.ts, channel: r.data!.channel } };
  }

  async addReaction(channel: string, timestamp: string, name: string): Promise<SlackResult> {
    return this.call('reactions.add', { channel, timestamp, name });
  }

  /** Validates a channel id and whether the bot can post there. */
  async channelInfo(channel: string): Promise<SlackResult<{ channel: { id: string; name: string; is_member: boolean } }>> {
    return this.call('conversations.info', { channel });
  }
}

/** Mention markup: <@U123> when a Slack id is known, otherwise the plain name. */
export function mention(slackUserId: string | null | undefined, fallbackName: string): string {
  return slackUserId?.trim() ? `<@${slackUserId.trim()}>` : fallbackName;
}

/** Slack's mrkdwn escaping for user-supplied text. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
