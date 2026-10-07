// shared 모듈(client.key 읽기)의 문구표(ko/en).
import { defineCatalog, type Lang } from "./i18n.js";

export const SHARED_MESSAGES = defineCatalog({
  ko: {
    client_key_unreadable: (p: { why: string; file: string }) =>
      `client.key를 읽을 수 없습니다(${p.why}): ${p.file}. Hub를 재시작해 보세요. MCP와 Hub의 UPLINK_DATA_DIR가 같은지도 확인하세요.`,
    client_key_malformed: (p: { file: string }) => `client.key를 읽을 수 없습니다(형식 오류): ${p.file}. Hub를 재시작해 보세요.`,
  },
  en: {
    client_key_unreadable: (p: { why: string; file: string }) =>
      `Cannot read client.key (${p.why}): ${p.file}. Try restarting the hub, and check that the MCP and the hub use the same UPLINK_DATA_DIR.`,
    client_key_malformed: (p: { file: string }) => `Cannot read client.key (malformed): ${p.file}. Try restarting the hub.`,
  },
});

export function sharedMsg(lang: Lang, key: keyof typeof SHARED_MESSAGES.ko, params: { why: string; file: string } | { file: string }): string {
  const e = SHARED_MESSAGES[lang][key] as (p: object) => string;
  return e(params);
}
