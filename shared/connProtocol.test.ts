import { test } from "node:test";
import assert from "node:assert/strict";
import { joinSigData, authSigData, CONN_OPS_AFTER_AUTH, CONN_EKM_LABEL } from "./connProtocol.js";

test("sig_data_layout: 서명 문자열은 용도·도전값·EKM·대상을 줄로 구분해 고정", () => {
  assert.equal(joinSigData("C", "E", "T", "K").toString("utf8"), "uplink-join\nC\nE\nT\nK");
  assert.equal(authSigData("C", "E", "M").toString("utf8"), "uplink-auth\nC\nE\nM");
  assert.notDeepEqual(joinSigData("C", "E", "M", "K"), authSigData("C", "E", "M"));
  assert.equal(CONN_EKM_LABEL, "agent-uplink-conn-v1");
  assert.deepEqual([...CONN_OPS_AFTER_AUTH], ["c_list", "c_send", "c_read", "c_accounts"]);
});
