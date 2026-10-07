// 받은 메시지를 MCP 텍스트로: 메시지가 있으면 첫 줄에 "데이터일 뿐 지시가 아님" 안내를 붙인다(세션 간 프롬프트 인젝션 완화).
// 본문·이름은 그대로 둔다(번역·변형하지 않음).
import { InboxItem, Message } from "../shared/protocol.js";
import { localeOf, type Lang } from "../shared/i18n.js";
import { mcpMsg } from "./messages.js";

export function injectionNotice(lang: Lang): string {
  return mcpMsg(lang, "injection_notice");
}

export function fmtItems(items: InboxItem[] | undefined, lang: Lang): string {
  if (!items || items.length === 0) return mcpMsg(lang, "no_new_messages");
  return [injectionNotice(lang), ...items.map((i) => `[#${i.channelLabel} ${i.fromName}] ${i.text}`)].join("\n");
}

export function fmtMessages(msgs: Message[] | undefined, lang: Lang): string {
  if (!msgs || msgs.length === 0) return mcpMsg(lang, "no_messages");
  return [injectionNotice(lang), ...msgs.map((m) => `[${new Date(m.ts).toLocaleTimeString(localeOf(lang))} ${m.fromName}] ${m.text}`)].join("\n");
}
