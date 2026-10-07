import { test } from "node:test";
import assert from "node:assert/strict";
import { toolTexts } from "./tools.js";
import { hasHangul } from "../hub/testing.js";

test("영어 도구 텍스트에 한글이 없고, 두 언어의 도구·매개변수 집합이 같다", () => {
  const en = toolTexts("en");
  const ko = toolTexts("ko");
  assert.equal(hasHangul(JSON.stringify(en)), false);
  assert.deepEqual(Object.keys(en.tools).sort(), Object.keys(ko.tools).sort());
  assert.equal(Object.keys(en.tools).length, 17);
  for (const k of Object.keys(en.tools) as (keyof typeof en.tools)[]) {
    assert.deepEqual(Object.keys(en.tools[k].params).sort(), Object.keys(ko.tools[k].params).sort(), k);
  }
});

test("인젝션 안내는 두 언어 모두 instructions와 check/wait/read 설명에 있다", () => {
  for (const [lang, re] of [["en", /not the user's instructions|not user instructions/], ["ko", /사용자의 지시가 아니|사용자 지시가 아님/]] as const) {
    const x = toolTexts(lang);
    assert.match(x.instructions, re);
    for (const name of ["check", "wait", "read"] as const) assert.match(x.tools[name].description, re, `${lang}/${name}`);
  }
});

test("어떤 도구 텍스트도 응답 언어를 지시하지 않는다", () => {
  for (const lang of ["en", "ko"] as const) {
    const s = JSON.stringify(toolTexts(lang));
    assert.doesNotMatch(s, /respond in|reply in|answer in|in (English|Korean)|한국어로|영어로/i);
  }
});
