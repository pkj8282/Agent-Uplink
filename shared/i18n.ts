// 한국어/영어 문구표 공통 도우미(순수 — 관리 앱 렌더러에서도 쓰도록 node 모듈을 쓰지 않는다).
export type Lang = "ko" | "en";
export type LangSetting = Lang | "N/A";

/** config.json의 language 값. ko/en 외(누락·대문자·객체 등)는 모두 N/A. */
export function parseLanguage(v: unknown): LangSetting {
  return v === "ko" || v === "en" ? v : "N/A";
}

/** 실제로 쓸 언어: ko만 한국어, en·N/A는 영어. */
export function effectiveLang(s: LangSetting): Lang {
  return s === "ko" ? "ko" : "en";
}

export type Entry = string | ((p: any) => string);
export type Args<E> = E extends (p: infer P) => string ? [params: P] : [];

/** ko의 키·시그니처를 en이 그대로 갖도록 강제한다(빠진 키·남는 키·params 불일치는 타입 오류). */
export function defineCatalog<T extends Record<string, Entry>>(c: { ko: T; en: NoInfer<T> }): { ko: T; en: T } {
  return c;
}

export function t<T extends Record<string, Entry>, K extends keyof T & string>(
  c: { ko: T; en: T },
  lang: Lang,
  key: K,
  ...args: Args<T[K]>
): string {
  const e = c[lang][key];
  return typeof e === "function" ? e(args[0]) : e;
}
