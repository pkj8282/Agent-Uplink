import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigFormState, deleteConfirmMessage, dmCountOf, memberNames, parseConfigForm } from "./view.js";

test("ConfigFormState: 저장 안 된 수정은 '저장됨'을 지우고 새로고침 덮어쓰기를 막는다", () => {
  const f = new ConfigFormState();
  assert.equal(f.acceptsRefresh(), true); // 초기: Hub 값으로 채워도 됨
  assert.deepEqual(f.saved(), { text: "저장했습니다(즉시 반영).", kind: "ok" });
  // 저장 후 다시 수정 → "저장했습니다"가 남으면 안 되고, 새로고침이 수정값을 덮으면 안 된다
  const dirty = f.edit();
  assert.equal(dirty.kind, "dirty");
  assert.match(dirty.text, /저장되지 않은 변경/);
  assert.equal(f.acceptsRefresh(), false);
  // 저장 실패 → 여전히 미저장
  assert.deepEqual(f.failed("저장 실패: x"), { text: "저장 실패: x", kind: "err" });
  assert.equal(f.acceptsRefresh(), false);
  // 저장 성공 → 다시 새로고침 반영
  f.saved();
  assert.equal(f.acceptsRefresh(), true);
});

test("parseConfigForm은 유효 입력을 숫자 patch로 바꾼다(앞뒤 공백 허용)", () => {
  assert.deepEqual(parseConfigForm({ maxChannelsPerServer: " 30 ", inboxMaxBatch: "100", allowDevDelete: false }), {
    ok: true,
    patch: { maxChannelsPerServer: 30, inboxMaxBatch: 100, allowDevDelete: false },
  });
  assert.deepEqual(parseConfigForm({ maxChannelsPerServer: "1", inboxMaxBatch: "007", allowDevDelete: true }), {
    ok: true,
    patch: { maxChannelsPerServer: 1, inboxMaxBatch: 7, allowDevDelete: true },
  });
});

test("parseConfigForm은 빈칸·0·음수·소수·문자·지수·초거대 수를 거부한다", () => {
  for (const bad of ["", "   ", "0", "-3", "1.5", "abc", "1e3", "99999999999999999999"]) {
    const r1 = parseConfigForm({ maxChannelsPerServer: bad, inboxMaxBatch: "100", allowDevDelete: true });
    assert.equal(r1.ok, false, `maxChannelsPerServer=${JSON.stringify(bad)}`);
    if (!r1.ok) assert.match(r1.error, /서버당 최대 채널 수/);
    const r2 = parseConfigForm({ maxChannelsPerServer: "30", inboxMaxBatch: bad, allowDevDelete: true });
    assert.equal(r2.ok, false, `inboxMaxBatch=${JSON.stringify(bad)}`);
    if (!r2.ok) assert.match(r2.error, /인박스 최대 배치/);
  }
});

test("deleteConfirmMessage는 대상·영향 범위·되돌릴 수 없음을 알린다", () => {
  const ch = deleteConfirmMessage({ kind: "channel", name: "일반", serverName: "데모" });
  assert.match(ch, /데모\/일반/);
  const srv = deleteConfirmMessage({ kind: "server", name: "데모", channelCount: 3 });
  assert.match(srv, /데모/);
  assert.match(srv, /채널 3개/);
  const acc = deleteConfirmMessage({ kind: "account", name: "알파", uuid: "u-1", dmCount: 2 });
  assert.match(acc, /알파/);
  assert.match(acc, /u-1/);
  assert.match(acc, /DM 2개/);
  for (const m of [ch, srv, acc]) assert.match(m, /되돌릴 수 없습니다/);
});

test("dmCountOf와 memberNames는 DM 멤버를 이름으로 보여주고 모르는 uuid를 표시한다", () => {
  const dms = [
    { channelId: "d1", members: ["u1", "u2"], label: "dm" },
    { channelId: "d2", members: ["u1", "u3"], label: "dm" },
  ];
  const accounts = [{ uuid: "u1", name: "알파" }, { uuid: "u2", name: "베타" }];
  assert.equal(dmCountOf("u1", dms), 2);
  assert.equal(dmCountOf("u2", dms), 1);
  assert.equal(dmCountOf("zz", dms), 0);
  assert.equal(memberNames(dms[0], accounts), "알파 ↔ 베타");
  assert.equal(memberNames(dms[1], accounts), "알파 ↔ (알 수 없음 u3)");
});
