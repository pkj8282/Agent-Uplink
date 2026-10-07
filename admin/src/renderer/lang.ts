// 렌더러의 현재 표시 언어(순수 — DOM 없음, Node에서 테스트). 시작 때와 설정에서 바꿀 때 setLang으로 정한다.
import type { Lang } from "../i18n.js";
import { adminMsg, type AdminKey } from "../messages.js";

let current: Lang = "en";

export function setLang(l: Lang): void {
  current = l;
}

export function getLang(): Lang {
  return current;
}

/** 현재 언어의 관리 앱 문구. */
export function tr(key: AdminKey, params?: object): string {
  return adminMsg(current, key, params);
}
