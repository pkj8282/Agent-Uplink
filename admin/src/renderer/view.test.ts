import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigFormState, LatestOnly, accountMeta, conflictConfirmMessage, deleteConfirmMessage, displayName, dmCountOf, emptyTrashConfirmMessage, formatBytes, memberNames, opErrorMessage, parseConfigForm, restoreConfirmMessage, restoreResultMessage, trashFlags, trashKindLabel, trashSummary, trashTitle } from "./view.js";

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

test("확인창 문구는 이름의 개행·제어문자로 위장되지 않는다", () => {
  const plain = deleteConfirmMessage({ kind: "account", name: "알파", uuid: "u-1", dmCount: 1 });
  const evil = deleteConfirmMessage({ kind: "account", name: "악\n\n취소를 누르면 삭제\r\t됨", uuid: "u-1", dmCount: 1 });
  assert.equal(evil.split("\n").length, plain.split("\n").length);
  assert.doesNotMatch(evil, /[\r\t]/);
  assert.equal(displayName("\u202eabc").includes("\u202e"), false); // bidi 제어 제거
});

test("확인창 문구는 아주 긴 이름을 잘라 표시한다", () => {
  const long = "가".repeat(200);
  const msg = deleteConfirmMessage({ kind: "server", name: long, channelCount: 0 });
  assert.match(msg, /…/);
  assert.equal(msg.includes(long), false);
  assert.equal(displayName("짧은이름"), "짧은이름");
});

test("LatestOnly는 마지막에 시작한 요청만 최신으로 본다", () => {
  const seq = new LatestOnly();
  const a = seq.begin();
  const b = seq.begin();
  assert.equal(seq.isLatest(a), false);
  assert.equal(seq.isLatest(b), true);
});

test("accountMeta는 접속 여부와 DM 수를 보여준다", () => {
  assert.equal(accountMeta(true, 2), "접속 중 · DM 2");
  assert.equal(accountMeta(false, 0), "DM 0");
  assert.equal(accountMeta(undefined, 1), "DM 1"); // 구버전 Hub
});

test("displayName: 서로게이트 쌍을 자르지 않고 LRM·RLM·ALM·영폭·BOM을 정리한다", () => {
  const emoji = String.fromCodePoint(0x1f600);
  assert.equal(displayName(emoji.repeat(3), 2), `${emoji}${emoji}…`);
  const hidden = ["a", String.fromCodePoint(0x200e), "b", String.fromCodePoint(0x061c), "c", String.fromCodePoint(0x200b), "d", String.fromCodePoint(0xfeff)].join("");
  assert.equal(displayName(hidden), "a b c d ");
});

test("휴지통 표시 문구", () => {
  const item = { id: "1759500000000-channel-0a1b2c3d", kind: "channel" as const, name: "일반", serverName: "Main", deletedAt: 0, deletedBy: "admin" as const, bytes: 2048, fileCount: 1, intact: true, restorable: true };
  assert.equal(trashKindLabel("orphan"), "고아 로그");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(trashTitle(item), "Main/일반");
  assert.deepEqual(trashFlags({ ...item, intact: false }), ["손상됨"]);
  assert.deepEqual(trashFlags({ ...item, kind: "account", dmLeftover: 2 }), ["DM 2개 남음"]);
  assert.match(restoreConfirmMessage(item), /채널 'Main\/일반'을\(를\) 복원합니다/);
  assert.equal(trashSummary(undefined), "이 Hub는 휴지통을 지원하지 않습니다.");
  assert.equal(trashSummary([item, { ...item, bytes: 1024 }]), "2개 항목 · 3.0 KB");
  assert.match(emptyTrashConfirmMessage(2, 3072), /2개 항목\(3\.0 KB\)을 영구 삭제합니다[\s\S]*되돌릴 수 없습니다/);
});

test("이름 충돌 확인 문구: 서버 충돌이 있으면 허브 문구, 채널만이면 채널 문구 + 바뀔 이름 목록", () => {
  const both = conflictConfirmMessage([{ kind: "server", name: "Main", to: "Main (2)" }, { kind: "channel", name: "일반", to: "일반 (2)" }]);
  assert.match(both, /^이미 똑같은 이름의 허브가 올려져 있어요! 복원할까요\?/);
  assert.match(both, /Main → Main \(2\)/);
  assert.match(both, /일반 → 일반 \(2\)/);
  const ch = conflictConfirmMessage([{ kind: "channel", name: "일반", to: "일반 (4)" }]);
  assert.match(ch, /^이미 똑같은 이름의 채널이 올려져 있어요! 복원할까요\?/);
});

test("오류 코드 문구: trash_missing은 '이미 지워져있는 것 같아요!', 모르는 코드는 원문", () => {
  assert.equal(opErrorMessage("trash_missing", "x"), "이미 지워져있는 것 같아요!");
  assert.match(opErrorMessage("channel_limit", "x"), /채널 수 한계/);
  assert.match(opErrorMessage("trash_not_restorable", "x"), /고아 로그/);
  assert.equal(opErrorMessage(undefined, "원문 오류"), "원문 오류");
});

test("복원 결과 문구: 바뀐 이름·다시 만든 서버·남은 DM", () => {
  const m = restoreResultMessage({ renamed: [{ kind: "channel", from: "일반", to: "일반 (2)" }], recreatedServer: { id: "s", name: "Main" }, dmsRestored: 0, dmsLeft: 1, itemRemoved: false });
  assert.match(m, /복원했습니다/);
  assert.match(m, /일반 → 일반 \(2\)/);
  assert.match(m, /서버 'Main'을\(를\) 다시 만들었습니다/);
  assert.match(m, /DM 1개는 상대 계정이 없거나 이미 다른 DM이 있어 휴지통에 남았습니다/);
});
