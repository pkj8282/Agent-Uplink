// MCP 도구 입력 스키마 공용 조각. 이름 길이는 Hub(validateName)와 같이 코드포인트로 센다
// (zod .max()는 UTF-16 길이라 이모지 이름을 Hub보다 먼저 거부한다).
import { z } from "zod";
import { NAME_MAX } from "../shared/protocol.js";

export function nameSchema(label: string) {
  return z
    .string()
    .min(1)
    .refine((s) => [...s].length <= NAME_MAX, { message: `${label}은 ${NAME_MAX}자 이하여야 합니다.` })
    .describe(`${label}(최대 ${NAME_MAX}자)`);
}
