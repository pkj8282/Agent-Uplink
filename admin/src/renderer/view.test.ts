import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigFormState, LatestOnly, accountMeta, conflictConfirmMessage, deleteConfirmMessage, displayName, dmCountOf, emptyTrashConfirmMessage, emptyTrashTargets, findingCounts, findingSource, formatBytes, memberNames, opErrorMessage, parseConfigForm, restoreConfirmMessage, restoreResultMessage, trashFlags, trashKindLabel, trashSummary, trashTitle, unseenCount, parseServerForm, parseInviteForm, parseJoinCode, serverEnableConfirmMessage, inviteConfirmMessage, revokeConfirmMessage, connEventLine, connErrorMessage, connUnsupportedMessage, saveBlockedMessage, ChangeGate, parseStorageForm, storageStatusLine, verifyResultMessage, parsePruneForm, parseSupabaseForm } from "./view.js";
import { setLang, tr } from "./lang.js";
import { hasHangul } from "../../../hub/testing.js";

// 아래 기존 단정은 한국어 화면 기준이다. 영어는 맨 아래 테스트에서 따로 본다.
setLang("ko");

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

test("deleteConfirmMessage는 대상·영향 범위와 휴지통 이동(복원 가능)을 알린다", () => {
  const ch = deleteConfirmMessage({ kind: "channel", name: "일반", serverName: "데모" });
  assert.match(ch, /데모\/일반/);
  const srv = deleteConfirmMessage({ kind: "server", name: "데모", channelCount: 3 });
  assert.match(srv, /데모/);
  assert.match(srv, /채널 3개/);
  const acc = deleteConfirmMessage({ kind: "account", name: "알파", uuid: "u-1", dmCount: 2 });
  assert.match(acc, /알파/);
  assert.match(acc, /u-1/);
  assert.match(acc, /DM 2개/);
  for (const m of [ch, srv, acc]) {
    assert.match(m, /휴지통으로 이동합니다/);
    assert.match(m, /휴지통 탭에서 복원할 수 있습니다/);
    assert.doesNotMatch(m, /되돌릴 수 없습니다/);
  }
  assert.match(acc, /알림은 복원되지 않습니다/); // 인박스 알림은 영구 삭제
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

test("io_error 코드는 파일 사용 중·재시도 안내 문구", () => {
  assert.match(opErrorMessage("io_error", "x"), /다른 프로그램이 사용 중/);
  assert.match(opErrorMessage("io_error", "x"), /다시 시도/);
});

test("영어 화면: 삭제 확인·휴지통 요약·오류 코드·폼 문구에 한글이 없다", () => {
  setLang("en");
  try {
    const item = { id: "1", kind: "channel" as const, name: "general", serverName: "Main", deletedAt: 0, deletedBy: "admin" as const, bytes: 2048, fileCount: 1, intact: false, restorable: true };
    assert.equal(trashSummary(undefined), "This hub does not support the trash.");
    assert.equal(trashSummary([item]), "1 item(s) · 2.0 KB");
    assert.match(deleteConfirmMessage({ kind: "server", name: "s", channelCount: 2 }), /^Delete server 's' and its 2 channel\(s\)\./);
    assert.match(opErrorMessage("trash_missing", "x"), /already been deleted/);
    assert.equal(opErrorMessage(undefined, "raw"), "raw");
    const texts = [
      trashKindLabel("orphan"), ...trashFlags({ ...item, dmLeftover: 2 }), restoreConfirmMessage(item),
      conflictConfirmMessage([{ kind: "server", name: "Main", to: "Main (2)" }]), conflictConfirmMessage([{ kind: "channel", name: "c", to: "c (2)" }]),
      restoreResultMessage({ renamed: [{ kind: "channel", from: "a", to: "a (2)" }], recreatedServer: { id: "s", name: "Main" }, dmsRestored: 0, dmsLeft: 1, itemRemoved: false }),
      emptyTrashConfirmMessage(3, 2048), deleteConfirmMessage({ kind: "channel", name: "c", serverName: "S" }),
      deleteConfirmMessage({ kind: "account", name: "a", uuid: "u", dmCount: 1 }),
      ...["trash_missing", "trash_not_restorable", "trash_bad_id", "channel_limit", "trash_busy", "io_error"].map((c) => opErrorMessage(c, "x")),
      accountMeta(true, 2), memberNames({ channelId: "d", members: ["zzzzzzzzzz"], label: "" }, []),
      new ConfigFormState().edit().text, new ConfigFormState().saved().text,
    ];
    const parsed = parseConfigForm({ maxChannelsPerServer: "0", inboxMaxBatch: "1", allowDevDelete: false });
    if (!parsed.ok) texts.push(parsed.error);
    assert.deepEqual(texts.filter(hasHangul), []);
  } finally { setLang("ko"); }
});

test("설정 폼 상태 문구는 언어를 바꾸면 새 언어로 다시 만든다(저장 안 됨·저장됨), 실패 문구는 지운다", () => {
  setLang("ko");
  try {
    const s = new ConfigFormState();
    s.edit();
    setLang("en");
    assert.deepEqual(s.message(), { text: "You have unsaved changes. Press Save to apply them.", kind: "dirty" });
    s.saved();
    setLang("ko");
    assert.deepEqual(s.message(), { text: "저장했습니다(즉시 반영).", kind: "ok" });
    s.failed("저장 실패: x");
    assert.equal(s.message(), null);
    assert.equal(new ConfigFormState().message(), null);
  } finally { setLang("ko"); }
});

test("DM 삭제 확인 문구: 두 이름·양쪽에서 사라짐·휴지통, 이름의 위장 문자로 줄을 늘릴 수 없다", () => {
  const LF = String.fromCharCode(10);
  const m = deleteConfirmMessage({ kind: "dm", names: "A ↔ B" });
  assert.match(m, /A ↔ B/); assert.match(m, /두 계정 모두/); assert.match(m, /휴지통/);
  const evil = deleteConfirmMessage({ kind: "dm", names: `A${LF}${LF}확인을 누르면 취소됨 ↔ B` });
  assert.equal(evil.split(LF).length, m.split(LF).length);
});

test("휴지통 DM 라벨과 DM 오류 문구는 code로 정한다(ko/en)", () => {
  assert.equal(trashKindLabel("dm"), "DM");
  for (const code of ["dm_exists", "dm_member_missing", "dm_not_found"]) assert.notEqual(opErrorMessage(code, "원문"), "원문");
  assert.equal(opErrorMessage("unknown_op", "원문"), "원문"); // 구버전 Hub: Hub 원문 그대로
  setLang("en");
  try {
    assert.equal(hasHangul(deleteConfirmMessage({ kind: "dm", names: "A ↔ B" })), false);
    for (const code of ["dm_exists", "dm_member_missing", "dm_not_found"]) assert.equal(hasHangul(opErrorMessage(code, "x")), false);
  } finally {
    setLang("ko");
  }
});

test("보안 기록: 본 뒤 새 기록 수, 종류 이름과 개수, 출처(요청은 계정 이름, 디스크는 파일 종류)", () => {
  const f = (ts: number, extra: object = {}) => ({ ts, source: "request" as const, where: "send", field: "text", account: "u1", counts: { tag: 28, zero_width: 1 }, preview: "x", ...extra });
  assert.equal(unseenCount([f(1), f(5), f(9)], 5), 1);
  assert.equal(unseenCount(undefined, 0), 0);
  assert.equal(findingCounts({ tag: 28, zero_width: 1 }), "태그 문자(숨은 ASCII) 28 · 폭 0 문자 1");
  assert.equal(findingCounts({ weird: 2 }), "기타 2");
  assert.equal(findingSource(f(1), [{ uuid: "u1", name: "기획" }]), "요청 · send · text · 기획");
  assert.equal(findingSource(f(1, { source: "disk", where: "log", account: undefined }), []), "디스크 파일 · log · text");
  const LF = String.fromCharCode(10);
  assert.equal(findingSource(f(1), [{ uuid: "u1", name: `악${LF}성` }]).includes(LF), false);
  setLang("en");
  try {
    assert.equal(hasHangul(findingCounts({ tag: 1, emoji_smuggling: 2, weird: 1 })), false);
    assert.equal(hasHangul(findingSource(f(1), [])), false);
  } finally {
    setLang("ko");
  }
});

// ── v2.1.3 ⑧ 남은 DM 재복원 결과 · ⑩ 휴지통 비우기 대상 ──
test("⑧ 남은 DM 재복원이 0건이면 '복원했습니다'가 아니라 '복원된 DM이 없습니다' + 남은 DM 안내", () => {
  const none = restoreResultMessage({ renamed: [], dmsRestored: 0, dmsLeft: 2, itemRemoved: false }, { leftoverOnly: true });
  assert.doesNotMatch(none, /복원했습니다/);
  assert.match(none, /^복원된 DM이 없습니다\./);
  assert.match(none, /DM 2개는/);
  assert.match(restoreResultMessage({ renamed: [], dmsRestored: 1, dmsLeft: 0, itemRemoved: true }, { leftoverOnly: true }), /^복원했습니다\./);
  assert.match(restoreResultMessage({ renamed: [], dmsRestored: 0, dmsLeft: 0, itemRemoved: true }), /^복원했습니다\./); // 일반 복원은 그대로
  setLang("en");
  try {
    assert.match(restoreResultMessage({ renamed: [], dmsRestored: 0, dmsLeft: 1, itemRemoved: false }, { leftoverOnly: true }), /^No DMs were restored\./);
  } finally {
    setLang("ko");
  }
});

test("⑩ emptyTrashTargets: 진행 중(pending) 항목은 비우기 개수·크기에서 뺀다", () => {
  const base = { kind: "channel" as const, name: "a", deletedAt: 0, deletedBy: "admin" as const, fileCount: 1, intact: true, restorable: true };
  const items = [{ ...base, id: "1", bytes: 2048 }, { ...base, id: "2", bytes: 5, pending: true as const }, { ...base, id: "3", bytes: 10 }];
  assert.deepEqual(emptyTrashTargets(items), { count: 2, bytes: 2058 });
  assert.deepEqual(emptyTrashTargets([{ ...base, id: "4", bytes: 1, pending: true as const }]), { count: 0, bytes: 0 });
  assert.deepEqual(emptyTrashTargets([]), { count: 0, bytes: 0 });
});

// ── v3.0 2단계: 통신 화면 ──
test("parseServerForm: 포트 1~65535 정수, 프로필 두 값만, 공간 이름 필수", () => {
  const base = { port: "47900", profile: "tls13-chacha20", spaceName: "팀", burnOnJoin: false };
  for (const port of ["0", "65536", "8a", "", "-1", "1.5"]) assert.equal(parseServerForm({ ...base, port }).ok, false, port);
  assert.deepEqual(parseServerForm({ ...base, port: " 47900 ", spaceName: " 팀 " }), { ok: true, value: { port: 47900, profile: "tls13-chacha20", spaceName: "팀", burnOnJoin: false } });
  assert.equal(parseServerForm({ ...base, profile: "x" }).ok, false);
  assert.equal(parseServerForm({ ...base, spaceName: "  " }).ok, false);
  const r = parseServerForm({ ...base, burnOnJoin: true, profile: "tls13-aes256gcm" });
  assert.equal(r.ok && r.value.burnOnJoin && r.value.profile, "tls13-aes256gcm");
});

test("parseInviteForm: 일수 1~30 → ms, 이름·주소 필수", () => {
  const base = { label: "비", host: "203.0.113.5", days: "7" };
  assert.deepEqual(parseInviteForm(base), { ok: true, value: { label: "비", host: "203.0.113.5", expiresInMs: 604_800_000 } });
  for (const days of ["0", "31", "x", ""]) assert.equal(parseInviteForm({ ...base, days }).ok, false, days);
  assert.equal(parseInviteForm({ ...base, label: " " }).ok, false);
  assert.equal(parseInviteForm({ ...base, host: " " }).ok, false);
  assert.equal(parseInviteForm({ ...base, days: "30" }).ok, true);
});

test("parseJoinCode: 앞뒤 공백만 자르고 비면 null", () => {
  assert.equal(parseJoinCode("  \n "), null);
  assert.equal(parseJoinCode(" UPLINK1-AB CD \n"), "UPLINK1-AB CD");
});

test("통신 확인창: IP 경고·포트·방화벽, 퇴출 확인", () => {
  const en = serverEnableConfirmMessage(47900);
  assert.match(en, /47900/);
  assert.match(en, /공인 IP/);
  assert.match(en, /방화벽/);
  const inv = inviteConfirmMessage("비", "203.0.113.5");
  assert.match(inv, /203\.0\.113\.5/);
  assert.match(inv, /공인 IP/);
  assert.match(revokeConfirmMessage("비"), /'비'/);
  const LF = String.fromCharCode(10);
  assert.equal(revokeConfirmMessage(`악${LF}성`).split(LF)[0].includes("성"), true); // 이름 속 줄바꿈은 정리
});

test("connEventLine·connErrorMessage: 아는 코드는 문구, 모르는 코드는 그대로", () => {
  assert.match(connEventLine({ ts: 1, code: "member_joined", detail: { memberId: "m", userName: "비" } }), /비/);
  assert.match(connEventLine({ ts: 1, code: "member_revoked", detail: { memberId: "m", userName: "비" } }), /퇴출/);
  assert.match(connEventLine({ ts: 1, code: "join_failed", detail: { ip: "198.51.100.7" } }), /198\.51\.100\.7/);
  assert.equal(connEventLine({ ts: 1, code: "brand_new", detail: {} }), "brand_new");
  assert.match(connErrorMessage("server_not_enabled", "fb"), /통신 서버/);
  assert.match(connErrorMessage("pin_mismatch", "fb"), /서버/);
  assert.match(connErrorMessage("invite_expired", "fb"), /만료/);
  assert.equal(connErrorMessage("whatever", "fb"), "fb");
  assert.equal(connErrorMessage(undefined, "fb"), "fb");
  assert.match(connUnsupportedMessage(), /통신/);
  assert.match(saveBlockedMessage(["servers/index.json"]), /servers\/index\.json/);
});

test("v3 Minor ③ 남은 DM 재복원 확인창은 계정 복원 문구와 다르다", () => {
  const t = { id: "1", kind: "account" as const, name: "기획", deletedAt: 0, deletedBy: "admin" as const, bytes: 1, fileCount: 1, intact: true, restorable: true };
  assert.match(restoreConfirmMessage(t), /계정 '기획'을\(를\) 복원합니다/);
  const left = restoreConfirmMessage({ ...t, dmLeftover: 2 });
  assert.doesNotMatch(left, /계정 '기획'을\(를\) 복원합니다/);
  assert.match(left, /남은 DM 2개/);
});

test("v3 통신 문구 영어 화면에 한글 없음", () => {
  setLang("en");
  try {
    const t = { id: "1", kind: "account" as const, name: "a", deletedAt: 0, deletedBy: "admin" as const, bytes: 1, fileCount: 1, intact: true, restorable: true, dmLeftover: 1 };
    for (const s of [serverEnableConfirmMessage(1), inviteConfirmMessage("a", "h"), revokeConfirmMessage("a"), connUnsupportedMessage(), saveBlockedMessage(["dm/index.json"]), restoreConfirmMessage(t),
      connEventLine({ ts: 1, code: "member_joined", detail: { userName: "a" } }), connErrorMessage("invite_expired", "")]) assert.equal(hasHangul(s), false, s);
    const bad = parseServerForm({ port: "0", profile: "x", spaceName: "", burnOnJoin: false });
    assert.equal(!bad.ok && hasHangul(bad.error), false);
  } finally {
    setLang("ko");
  }
});

test("ChangeGate: 값이 바뀐 목록만 다시 그린다(통신 탭 자동 갱신이 입력·포커스를 지우지 않게)", () => {
  const g = new ChangeGate();
  assert.equal(g.changed("members", [{ id: "m", online: true }]), true); // 처음
  assert.equal(g.changed("members", [{ id: "m", online: true }]), false); // 같음
  assert.equal(g.changed("members", [{ id: "m", online: false }]), true); // 끊김
  assert.equal(g.changed("events", []), true); // 다른 목록은 따로
  g.reset();
  assert.equal(g.changed("members", [{ id: "m", online: false }]), true); // 언어 변경 등 강제 다시 그리기
});

// ── v3.0 3a: 저장소(백업) ──
test("parseStorageForm: 저장소 owner/name, 토큰, 주기 1~60분", () => {
  const base = { repo: "me/backup", token: "github_pat_x", intervalMin: "5" };
  assert.deepEqual(parseStorageForm(base), { ok: true, value: { repo: "me/backup", token: "github_pat_x", intervalMin: 5 } });
  assert.deepEqual(parseStorageForm({ ...base, repo: " me/backup ", token: " github_pat_x " }), { ok: true, value: { repo: "me/backup", token: "github_pat_x", intervalMin: 5 } });
  for (const repo of ["me", "me/a/b", "", "a/b c"]) assert.equal(parseStorageForm({ ...base, repo }).ok, false, repo);
  for (const token of ["", "  ", "a b"]) assert.equal(parseStorageForm({ ...base, token }).ok, false, token);
  for (const intervalMin of ["0", "61", "x"]) assert.equal(parseStorageForm({ ...base, intervalMin }).ok, false, intervalMin);
  assert.equal(parseStorageForm({ ...base, intervalMin: "60" }).ok, true);
});

test("storageStatusLine·verifyResultMessage: 상태와 검증 결과 문구", () => {
  assert.match(storageStatusLine({ configured: false, lastUploadAt: null, lastError: null, nextIndex: 0 }), /연결 안 됨/);
  const on = storageStatusLine({ configured: true, kind: "github", repo: "me/backup", intervalMin: 5, lastUploadAt: null, lastError: null, nextIndex: 0 });
  assert.match(on, /me\/backup/);
  assert.match(on, /5분/);
  assert.match(storageStatusLine({ configured: true, kind: "github", repo: "me/b", intervalMin: 5, lastUploadAt: 1, lastError: "storage_auth_failed", nextIndex: 3 }), /토큰/);
  assert.match(verifyResultMessage({ fragments: 3, messages: 10, breaks: [], missing: [], bad: [] }), /이상 없음/);
  const warn = verifyResultMessage({ fragments: 2, messages: 7, breaks: [2], missing: [1], bad: [{ path: "p", code: "frag_bad_signature" }] });
  assert.match(warn, /빠진 조각 1/);
  assert.match(warn, /변조/);
  setLang("en");
  try {
    for (const s of [storageStatusLine({ configured: false, lastUploadAt: null, lastError: null, nextIndex: 0 }), verifyResultMessage({ fragments: 1, messages: 1, breaks: [1], missing: [0], bad: [] }),
      connErrorMessage("storage_rate_limited", ""), connEventLine({ ts: 1, code: "storage_uploaded", detail: { fragments: 1, messages: 2 } })]) assert.equal(hasHangul(s), false, s);
    const bad = parseStorageForm({ repo: "", token: "", intervalMin: "" });
    assert.equal(!bad.ok && hasHangul(bad.error), false);
  } finally {
    setLang("ko");
  }
});

test("복구 키 경고: 잃으면 못 읽음 + 가진 사람은 누구나 읽음(보내지 말 것) — 지휘 관문 ③", () => {
  assert.match(tr("storage_recovery_hint"), /누구나 백업을 읽을 수/);
  assert.match(tr("storage_recovery_hint"), /붙여 넣지 마세요/);
  setLang("en");
  try {
    assert.match(tr("storage_recovery_hint"), /Anyone who has this key can read the backup/);
  } finally {
    setLang("ko");
  }
});

test("통신 서버·채널 삭제 항목은 휴지통에 '통신' 표시", () => {
  const t = { id: "1", kind: "channel" as const, name: "main", serverName: "팀작업", deletedAt: 0, deletedBy: "admin" as const, bytes: 1, fileCount: 1, intact: true, restorable: true };
  assert.deepEqual(trashFlags(t), []);
  assert.deepEqual(trashFlags({ ...t, area: "connection" as const }), ["통신"]);
  setLang("en");
  try {
    assert.deepEqual(trashFlags({ ...t, area: "connection" as const }), ["Connections"]);
  } finally {
    setLang("ko");
  }
});

// ── v3.0 3b ──
test("parsePruneForm: 정리 일수 7~365", () => {
  assert.deepEqual(parsePruneForm({ enabled: true, days: "30" }), { ok: true, value: { enabled: true, days: 30 } });
  for (const days of ["6", "366", "x", ""]) assert.equal(parsePruneForm({ enabled: true, days }).ok, false, days);
});

test("3b 새 사건 문구, 영어 화면에 한글 없음", () => {
  assert.match(connEventLine({ ts: 1, code: "unclean_shutdown_detected", detail: {} }), /비정상 종료/);
  assert.match(connEventLine({ ts: 1, code: "prune_done", detail: { removed: 3 } }), /3/);
  assert.match(connEventLine({ ts: 1, code: "prune_skipped", detail: {} }), /정리하지 않음/);
  assert.match(storageStatusLine({ configured: true, kind: "github", repo: "o/r", intervalMin: 5, lastUploadAt: null, lastError: null, nextIndex: 0, prune: { enabled: true, days: 30, lastPruneAt: 1 } }), /로컬 정리 30일/);
  setLang("en");
  try {
    for (const t of [connEventLine({ ts: 1, code: "unclean_shutdown_detected", detail: {} }), connEventLine({ ts: 1, code: "prune_done", detail: { removed: 1 } }),
      storageStatusLine({ configured: true, kind: "github", repo: "o/r", intervalMin: 5, lastUploadAt: null, lastError: null, nextIndex: 0, prune: { enabled: true, days: 30, lastPruneAt: 1 } })]) assert.equal(hasHangul(t), false, t);
  } finally {
    setLang("ko");
  }
});

test("로컬 정리 확인창: 정리 뒤 저장소 백업이 유일한 사본임을 알림 — 지휘 관문", () => {
  assert.match(tr("prune_confirm", { days: 30 }), /유일한 사본/);
  assert.match(tr("prune_confirm", { days: 30 }), /되찾을 수 없습니다/);
  setLang("en");
  try {
    assert.match(tr("prune_confirm", { days: 30 }), /the only copy/);
  } finally {
    setLang("ko");
  }
});

// ── Supabase(2026-11-07, Google Drive 대신) ──
test("parseSupabaseForm: https://<ref>.supabase.co·secret key·버킷(기본 agent-uplink)·주기", () => {
  const base = { url: "https://abcdefghijklmnopqrst.supabase.co", key: "sb_secret_x", bucket: "", intervalMin: "5" };
  assert.deepEqual(parseSupabaseForm(base), { ok: true, value: { url: "https://abcdefghijklmnopqrst.supabase.co", key: "sb_secret_x", bucket: "agent-uplink", intervalMin: 5 } });
  assert.deepEqual(parseSupabaseForm({ ...base, url: " https://abcdefghijklmnopqrst.supabase.co/ ", bucket: " my-backup " }).ok, true);
  for (const url of ["http://abc.supabase.co", "https://abc.supabase.co.evil.com", "https://evil.com", ""]) assert.equal(parseSupabaseForm({ ...base, url }).ok, false, url);
  for (const key of ["", " ", "a b"]) assert.equal(parseSupabaseForm({ ...base, key }).ok, false, key);
  for (const bucket of ["Bad", "a/b", "-x"]) assert.equal(parseSupabaseForm({ ...base, bucket }).ok, false, bucket);
  assert.equal(parseSupabaseForm({ ...base, intervalMin: "0" }).ok, false);
});

test("Supabase 상태 줄: 프로젝트 이름·주기, 닿지 못하면 일시정지 안내, 영어 한글 없음", () => {
  const st = { configured: true, kind: "supabase" as const, url: "https://abcdefghijklmnopqrst.supabase.co", bucket: "agent-uplink", intervalMin: 5, lastUploadAt: null, lastError: null, nextIndex: 0 };
  assert.match(storageStatusLine(st), /Supabase abcdefghijklmnopqrst · 5분마다/);
  assert.match(storageStatusLine({ ...st, lastError: "storage_unreachable" }), /일시정지/);
  assert.doesNotMatch(storageStatusLine({ ...st, kind: "github" as const, repo: "o/r", lastError: "storage_unreachable" }), /일시정지/);
  setLang("en");
  try {
    for (const t of [storageStatusLine({ ...st, lastError: "storage_unreachable" }), parseSupabaseForm({ url: "", key: "", bucket: "", intervalMin: "" }).ok ? "" : (parseSupabaseForm({ url: "", key: "", bucket: "", intervalMin: "" }) as any).error]) {
      assert.equal(hasHangul(t), false, t);
    }
  } finally {
    setLang("ko");
  }
});

test("저장소 오류 문구는 GitHub 전용이 아니다(Supabase에서도 맞는 말)", () => {
  for (const code of ["storage_auth_failed", "storage_bad_response", "storage_unreachable", "storage_rate_limited", "storage_repo_not_found", "storage_forbidden"]) {
    const ko = connErrorMessage(code, "");
    assert.doesNotMatch(ko, /^GitHub(가|에|의)/, code);
    assert.ok(ko.length > 0, code);
  }
  assert.match(connErrorMessage("storage_auth_failed", ""), /키/);
  assert.match(connErrorMessage("storage_forbidden", ""), /Supabase/);
  setLang("en");
  try {
    for (const code of ["storage_bad_response", "storage_unreachable", "storage_rate_limited"]) assert.doesNotMatch(connErrorMessage(code, ""), /^(GitHub sent|Could not reach GitHub|Hit the GitHub)/, code);
  } finally {
    setLang("ko");
  }
});

// ── 4단계: 공간(방식 1) ──
import { parseS1CreateForm, parseS1JoinForm, space1StateLabel, space1RevokeConfirm, space1LeaveConfirm } from "./view.js";

test("parseS1CreateForm·parseS1JoinForm: 이름·로컬 서버·GitHub 저장소·토큰·주기 10~600초 / 코드·토큰", () => {
  const base = { spaceName: "공간", localServerId: "srv-1", repo: "me/space", token: "ghp_x", intervalSec: "30" };
  assert.deepEqual(parseS1CreateForm(base), { ok: true, value: { spaceName: "공간", localServerId: "srv-1", repo: "me/space", ghToken: "ghp_x", intervalSec: 30 } });
  for (const k of ["spaceName", "localServerId", "token"] as const) assert.equal(parseS1CreateForm({ ...base, [k]: " " }).ok, false, k);
  for (const repo of ["me", "a/b/c", "../x"]) assert.equal(parseS1CreateForm({ ...base, repo }).ok, false, repo);
  for (const intervalSec of ["9", "601", "x"]) assert.equal(parseS1CreateForm({ ...base, intervalSec }).ok, false, intervalSec);
  assert.deepEqual(parseS1JoinForm({ code: " UPLINKS1-AB\n ", token: " ghp_y " }), { ok: true, value: { code: "UPLINKS1-AB", ghToken: "ghp_y" } });
  assert.equal(parseS1JoinForm({ code: "", token: "t" }).ok, false);
  assert.equal(parseS1JoinForm({ code: "UPLINKS1-A", token: "a b" }).ok, false);
});

test("공간 상태·확인창·사건·오류 문구, 영어 한글 없음", () => {
  assert.match(space1StateLabel("owner", "active"), /관리자/);
  assert.match(space1StateLabel("member", "pending"), /승인 대기/);
  assert.match(space1StateLabel("member", "revoked"), /퇴출/);
  assert.match(space1RevokeConfirm("씨"), /되돌릴 수 없습니다/);
  assert.match(space1RevokeConfirm("씨"), /협력자/);
  assert.match(space1LeaveConfirm("공간"), /저장소의 파일은 그대로/);
  assert.match(connEventLine({ ts: 1, code: "space1_member_joined", detail: { userName: "비" } }), /비/);
  assert.match(connErrorMessage("invite_not_space", ""), /방식 2/);
  setLang("en");
  try {
    for (const t of [space1StateLabel("owner", "active"), space1StateLabel("member", "pending"), space1RevokeConfirm("a"), space1LeaveConfirm("a"),
      connEventLine({ ts: 1, code: "space1_member_revoked", detail: { userName: "a" } }), connEventLine({ ts: 1, code: "space1_fragment_rejected", detail: {} }),
      connErrorMessage("space_not_found", ""), connErrorMessage("space1_config_invalid", "")]) assert.equal(hasHangul(t), false, t);
    const bad = parseS1CreateForm({ spaceName: "", localServerId: "", repo: "", token: "", intervalSec: "" });
    assert.equal(!bad.ok && hasHangul(bad.error), false);
  } finally {
    setLang("ko");
  }
});

// ── 5단계: 서버 연결(방식 3) ──
import { parseMeshCaseForm, meshCaseLabel, meshUploadLine, meshInviteConfirm, meshRemoveConfirm, meshAcceptConfirm, meshCommandWhat, meshCommandConfirm } from "./view.js";

test("parseMeshCaseForm: 분산화는 메인 없음, 메인 지정·분산 안 함은 메인 필수, 예비는 메인 지정만", () => {
  assert.deepEqual(parseMeshCaseForm({ kase: "distributed", main: "x", standby: ["y"] }), { ok: true, value: { case: "distributed", standby: [] } });
  assert.deepEqual(parseMeshCaseForm({ kase: "main", main: "spA", standby: ["spC", "spA"] }), { ok: true, value: { case: "main", main: "spA", standby: ["spC"] } });
  assert.deepEqual(parseMeshCaseForm({ kase: "single", main: "spA", standby: ["spC"] }), { ok: true, value: { case: "single", main: "spA", standby: [] } });
  assert.equal(parseMeshCaseForm({ kase: "main", main: "", standby: [] }).ok, false);
  assert.equal(parseMeshCaseForm({ kase: "other", main: "spA", standby: [] }).ok, false);
});

test("망 문구: 경우·올리기·확인창·명령(한국어), 영어엔 한글 없음", () => {
  const nameOf = (id: string) => ({ spA: "에이 서버", spC: "씨 서버" } as Record<string, string>)[id] ?? id;
  assert.match(meshCaseLabel({ case: "main", main: "spA", standby: [] }, nameOf), /에이 서버/);
  assert.match(meshCaseLabel({ case: "distributed", standby: [] }, nameOf), /분산화/);
  assert.match(meshUploadLine({ own: true, mirrors: 3 }), /3/);
  assert.match(meshUploadLine({ own: false, mirrors: 0 }), /메인/);
  assert.match(meshInviteConfirm("씨 서버", "203.0.113.5"), /공인 IP/);
  assert.match(meshInviteConfirm("씨 서버", "203.0.113.5"), /1회용/);
  assert.match(meshRemoveConfirm("씨 서버"), /다시 붙을 수 없습니다/);
  assert.match(meshAcceptConfirm("에이 서버"), /묻지 않고 따릅니다/);
  assert.match(meshAcceptConfirm("에이 서버"), /철회/);
  assert.match(meshCommandWhat({ type: "cut", target: "spC" }, nameOf, () => ""), /씨 서버/);
  assert.match(meshCommandWhat({ type: "unshare", target: "spC", ch: "c1" }, nameOf, () => "일반"), /일반/);
  assert.match(meshCommandWhat({ type: "noWrite", entry: "spC", hubUser: "비" }, nameOf, () => ""), /비/);
  assert.match(meshCommandConfirm("무엇"), /묻지 않고 따릅니다/);
  assert.match(connEventLine({ ts: 1, code: "link_added", detail: { spaceName: "씨 서버" } }), /씨 서버/);
  assert.match(connEventLine({ ts: 1, code: "mesh_link_dropped", detail: {} }), /끊/);
  assert.match(connErrorMessage("not_link_invite", ""), /통신 탭/);
  assert.match(connErrorMessage("not_coordinator", ""), /총괄/);
  setLang("en");
  try {
    for (const t of [meshCaseLabel({ case: "single", main: "spA", standby: [] }, (i) => i), meshCaseLabel({ case: "distributed", standby: [] }, (i) => i),
      meshUploadLine({ own: true, mirrors: 1 }), meshUploadLine({ own: true, mirrors: 0 }), meshUploadLine({ own: false, mirrors: 0 }),
      meshInviteConfirm("a", "h"), meshRemoveConfirm("a"), meshAcceptConfirm("a"), meshCommandConfirm("a"),
      meshCommandWhat({ type: "cut", target: "x" }, (i) => i, () => "c"), meshCommandWhat({ type: "case", choice: { case: "distributed", standby: [] } }, (i) => i, () => ""),
      meshCommandWhat({ type: "noWrite", entry: "x" }, (i) => i, () => ""), meshCommandWhat({ type: "unshare", target: "x", ch: "y" }, (i) => i, () => "c"),
      connEventLine({ ts: 1, code: "link_removed", detail: {} }), connEventLine({ ts: 1, code: "mesh_reject_record_forged", detail: {} }),
      connEventLine({ ts: 1, code: "gov_command_applied", detail: { type: "cut" } }), connErrorMessage("relay_timeout", ""), connErrorMessage("link_self", "")]) assert.equal(hasHangul(t), false, t);
    const bad = parseMeshCaseForm({ kase: "main", main: "", standby: [] });
    assert.equal(!bad.ok && hasHangul(bad.error), false);
  } finally {
    setLang("ko");
  }
});

// ── 7단계: 다른 PC 백업 가져오기 ──
import { parseRestoreForm, backupCandidateLine, backupRestoreConfirm, backupRestoreDone } from "./view.js";

test("parseRestoreForm: GitHub(저장소·토큰)·Supabase(주소·키·버킷) + 복구 키·서버 이름", () => {
  const base = { kind: "github", repo: "me/backup", token: " ghp_x ", url: "", key: "", bucket: "", recoveryKey: " abcd-efgh \n", serverName: " 복원 " };
  assert.deepEqual(parseRestoreForm(base), { ok: true, value: { kind: "github", repo: "me/backup", ghToken: "ghp_x", recoveryKey: "abcd-efgh", serverName: "복원" } });
  assert.deepEqual(parseRestoreForm({ ...base, kind: "supabase", url: "https://abc.supabase.co/", key: "sb_secret_x", bucket: "" }),
    { ok: true, value: { kind: "supabase", url: "https://abc.supabase.co", key: "sb_secret_x", bucket: "agent-uplink", recoveryKey: "abcd-efgh", serverName: "복원" } });
  assert.equal(parseRestoreForm({ ...base, repo: "me" }).ok, false);
  assert.equal(parseRestoreForm({ ...base, token: "" }).ok, false);
  assert.equal(parseRestoreForm({ ...base, recoveryKey: "" }).ok, false);
  assert.equal(parseRestoreForm({ ...base, recoveryKey: "ab!cd" }).ok, false);
  // 뭔가 넣었는데 형식이 틀리면 "넣으세요"가 아니라 "올바르지 않습니다" — 비었을 때만 "넣으세요"
  const empty = parseRestoreForm({ ...base, recoveryKey: "  " });
  assert.ok(!empty.ok && /넣으세요/.test(empty.error));
  const wrongChar = parseRestoreForm({ ...base, recoveryKey: "abc1-efgh" });
  assert.ok(!wrongChar.ok && /올바르지 않습니다/.test(wrongChar.error));
  assert.equal(parseRestoreForm({ ...base, serverName: " " }).ok, false);
});

test("복원 문구: 후보·확인창·결과(끊김·거부 조각), 영어엔 한글 없음", () => {
  const c = { spaceId: "s", hubId: "h", fragments: 3, firstDay: "2026-11-01", lastDay: "2026-11-07" };
  assert.match(backupCandidateLine(c), /2026-11-01/);
  assert.match(backupRestoreConfirm("복원", c), /저장하지 않습니다/);
  assert.match(backupRestoreDone({ channelCount: 2, messageCount: 10, breaks: [], bad: [] }), /10/);
  assert.match(backupRestoreDone({ channelCount: 1, messageCount: 1, breaks: [3], bad: [{ path: "p", code: "frag_bad_signature" }] }), /끊긴/);
  assert.match(connErrorMessage("recovery_key_invalid", ""), /복구 키/);
  setLang("en");
  try {
    for (const t of [backupCandidateLine(c), backupRestoreConfirm("x", c), backupRestoreDone({ channelCount: 1, messageCount: 1, breaks: [1], bad: [{ path: "p", code: "x" }] }),
      connErrorMessage("recovery_key_invalid", ""), connErrorMessage("restore_empty", ""), connEventLine({ ts: 1, code: "storage_restored", detail: { messages: 3 } })]) assert.equal(hasHangul(t), false, t);
    assert.match(backupRestoreDone({ channelCount: 1, messageCount: 3, breaks: [], bad: [] }), /channels: 1 · messages: 3/);
    const bad = parseRestoreForm({ kind: "github", repo: "", token: "", url: "", key: "", bucket: "", recoveryKey: "", serverName: "" });
    assert.equal(!bad.ok && hasHangul(bad.error), false);
  } finally {
    setLang("ko");
  }
});
