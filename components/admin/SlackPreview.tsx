'use client';

import { Fragment, type ReactNode } from 'react';

/**
 * A close look-alike of how Slack shows a Block Kit message (header, context, section text and
 * fields, divider), so admins can see the report's Slack post before it goes out. Only the
 * block types the reports use are drawn; mrkdwn covers *bold*, _italic_, `code`, <url|links>,
 * line breaks and the emoji codes the reports use.
 */

type Text = { type: string; text: string };
type Block = { type: string; text?: Text; fields?: Text[]; elements?: Text[] };

const EMOJI: Record<string, string> = { ':bar_chart:': '📊', ':calendar:': '📅' };

function inline(text: string, key: string): ReactNode[] {
  // Links first, then bold / italic / code inside the remaining text.
  const out: ReactNode[] = [];
  const re = /<([^|>]+)\|([^>]+)>|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(decode(text.slice(last, m.index)));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<a key={k} href={m[1]} target="_blank" rel="noreferrer" className="text-[#1264a3] hover:underline">{decode(m[2]!)}</a>);
    else if (m[3]) out.push(<b key={k}>{decode(m[3])}</b>);
    else if (m[4]) out.push(<i key={k}>{decode(m[4])}</i>);
    else if (m[5]) out.push(<code key={k} className="rounded border border-[#e8e8e8] bg-[#f8f8f8] px-1 text-[12px] text-[#e01e5a]">{m[5]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(decode(text.slice(last)));
  return out;
}

function Mrkdwn({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i, all) => (
        <Fragment key={i}>
          {inline(line, String(i))}
          {i < all.length - 1 && <br />}
        </Fragment>
      ))}
    </>
  );
}

export function SlackPreview({ blocks, text, channel, as }: { blocks: Block[]; text: string; channel: string | null; as: { username: string; iconEmoji: string } }) {
  const icon = EMOJI[as.iconEmoji] ?? '🤖';
  return (
    <div className="flex h-full flex-col bg-white text-[15px] leading-[1.46668] text-[#1d1c1d]" style={{ fontFamily: 'Lato, "Slack-Lato", "Helvetica Neue", Helvetica, Arial, sans-serif' }}>
      <div className="flex items-center justify-between border-b border-[#e8e8e8] px-5 py-2.5 text-sm">
        <span className="font-bold"># {channel ?? <span className="font-normal text-[#b5463c]">no channel set</span>}</span>
        <span className="text-xs text-[#616061]">Notification text: “{text.slice(0, 80)}{text.length > 80 ? '…' : ''}”</span>
      </div>
      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="flex gap-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#f4ede4] text-xl">{icon}</div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-black">{as.username}</span>
              <span className="rounded-sm bg-[#e8e8e8] px-1 text-[10px] font-bold text-[#616061]">APP</span>
              <span className="text-xs text-[#616061]">8:00 PM</span>
            </div>
            <div className="mt-1 space-y-2">
              {blocks.map((b, i) => {
                if (b.type === 'header') return <div key={i} className="text-lg font-black">{b.text?.text}</div>;
                if (b.type === 'divider') return <hr key={i} className="border-[#e8e8e8]" />;
                if (b.type === 'context')
                  return (
                    <div key={i} className="text-[13px] text-[#616061]">
                      {b.elements?.map((el, j) => <Mrkdwn key={j} text={el.text} />)}
                    </div>
                  );
                if (b.type === 'section')
                  return (
                    <div key={i}>
                      {b.text && <div className="break-words"><Mrkdwn text={b.text.text} /></div>}
                      {b.fields && (
                        <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-2">
                          {b.fields.map((f, j) => <div key={j} className="break-words"><Mrkdwn text={f.text} /></div>)}
                        </div>
                      )}
                    </div>
                  );
                return null;
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
