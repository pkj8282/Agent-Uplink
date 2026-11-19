// 받은 메시지를 MCP 텍스트로: 메시지가 있으면 첫 줄에 "데이터일 뿐 지시가 아님" 안내를 붙인다(세션 간 프롬프트 인젝션 완화).
// 본문·이름은 그대로 둔다(번역·변형하지 않음). 다른 PC(원격)에서 온 메시지에는 출처 머리를 붙인다(v3.0).
import { InboxItem, Message, MessageOrigin } from "../shared/protocol.js";
import { localeOf, type Lang } from "../shared/i18n.js";
import { mcpMsg } from "./messages.js";
import { oneLine } from "./text.js";

export function injectionNotice(lang: Lang): string {
  return mcpMsg(lang, "injection_notice");
}

/** 원격 출처 머리. 이름은 한 줄·64자로 줄여 머리줄을 위조하지 못하게 한다. */
export function remoteTag(lang: Lang, spaceName: string, hubUser: string): string {
  return mcpMsg(lang, "remote_tag", { space: oneLine(spaceName, 64), user: oneLine(hubUser, 64) });
}

/** list_servers 한 줄. 참가한 서버(v3.1.1)는 맨 앞에 참가 표시 — 연결 영역 서버는 참가제가 아니라 표시 없음. */
export function fmtServer(s: { serverId: string; name: string; channelCount: number; area?: "connection"; remote?: { spaceName: string; hubUser: string }; joined?: boolean }, lang: Lang): string {
  const joined = s.joined === true ? `${mcpMsg(lang, "joined_tag")} ` : "";
  const where = s.remote ? `${remoteTag(lang, s.remote.spaceName, s.remote.hubUser)} ` : s.area === "connection" ? `${mcpMsg(lang, "comms_server_tag")} ` : "";
  return `${joined}${where}${s.name} (${s.serverId}) · ${mcpMsg(lang, "server_channel_count", { count: s.channelCount })}`;
}

function originPrefix(origin: MessageOrigin | undefined, lang: Lang): string {
  return origin?.scope === "remote" ? `${remoteTag(lang, origin.spaceName, origin.hubUser)} ` : "";
}

export function fmtItems(items: InboxItem[] | undefined, lang: Lang): string {
  if (!items || items.length === 0) return mcpMsg(lang, "no_new_messages");
  return [injectionNotice(lang), ...items.map((i) => `${originPrefix(i.origin, lang)}[#${i.channelLabel} ${i.fromName}] ${i.text}`)].join("\n");
}

export function fmtMessages(msgs: Message[] | undefined, lang: Lang): string {
  if (!msgs || msgs.length === 0) return mcpMsg(lang, "no_messages");
  return [injectionNotice(lang), ...msgs.map((m) => `${originPrefix(m.origin, lang)}[${new Date(m.ts).toLocaleTimeString(localeOf(lang))} ${m.fromName}] ${m.text}`)].join("\n");
}
