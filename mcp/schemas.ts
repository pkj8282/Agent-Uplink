// MCP 도구 입력 스키마 공용 조각. 이름 길이는 Hub(validateName)와 같이 코드포인트로 센다
// (zod .max()는 UTF-16 길이라 이모지 이름을 Hub보다 먼저 거부한다).
import { z } from "zod";
import { NAME_MAX } from "../shared/protocol.js";
import type { Lang } from "../shared/i18n.js";
import { mcpMsg } from "./messages.js";

/** label은 도구 텍스트(tools.ts)의 매개변수 설명, lang은 등록 시점 언어. */
export function nameSchema(label: string, lang: Lang) {
  return z
    .string()
    .min(1)
    .refine((s) => [...s].length <= NAME_MAX, { message: mcpMsg(lang, "name_too_long", { label, max: NAME_MAX }) })
    .describe(mcpMsg(lang, "name_param", { label, max: NAME_MAX }));
}
