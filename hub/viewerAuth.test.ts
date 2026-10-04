import { test } from "node:test";
import assert from "node:assert/strict";
import { ViewerAuth, TICKET_TTL_MS, VIEWER_COOKIE, readCookie } from "./viewerAuth.js";

test("티켓은 1회용이고 세션 값을 준다", () => {
  const v = new ViewerAuth();
  const t = v.issueTicket();
  const s = v.redeem(t);
  assert.match(s!, /^[0-9a-f]{64}$/);
  assert.equal(v.redeem(t), null);
  assert.equal(v.hasSession(`${VIEWER_COOKIE}=${s}`), true);
  assert.equal(v.hasSession(`a=1; ${VIEWER_COOKIE}=${s}; b=2`), true);
});

test("RT17: 만료된 티켓은 거부", () => {
  let now = 1000;
  const v = new ViewerAuth(() => now);
  const t = v.issueTicket();
  now += TICKET_TTL_MS;
  assert.equal(v.redeem(t), null);
});

test("형식이 틀린 티켓·쿠키는 거부", () => {
  const v = new ViewerAuth();
  for (const bad of [undefined, null, "", "x", "A".repeat(64), 5]) assert.equal(v.redeem(bad), null);
  assert.equal(v.hasSession(undefined), false);
  assert.equal(v.hasSession(`${VIEWER_COOKIE}=${"a".repeat(64)}`), false); // 발급 안 된 값
});

test("미사용 티켓·세션은 16개까지, 넘으면 가장 오래된 것부터 폐기", () => {
  const v = new ViewerAuth();
  const tickets = Array.from({ length: 17 }, () => v.issueTicket());
  assert.equal(v.redeem(tickets[0]), null);
  const sessions = tickets.slice(1).map((t) => v.redeem(t)!);
  const extra = v.redeem(v.issueTicket())!;
  assert.equal(v.hasSession(`${VIEWER_COOKIE}=${sessions[0]}`), false);
  assert.equal(v.hasSession(`${VIEWER_COOKIE}=${extra}`), true);
});

test("readCookie는 이름이 정확히 같은 것만 꺼낸다", () => {
  assert.equal(readCookie("x_uplink_viewer=1; uplink_viewer=2", "uplink_viewer"), "2");
  assert.equal(readCookie("uplink_viewer2=1", "uplink_viewer"), null);
});
