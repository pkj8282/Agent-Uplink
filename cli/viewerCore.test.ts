import { test } from "node:test";
import assert from "node:assert/strict";
import { openViewer, browserCommand } from "./viewerCore.js";
import { HubClient } from "../mcp/hubClient.js";
import { startTestHub, httpGet } from "../hub/testing.js";

test("인증된 Hub에서 티켓 URL을 받아 연다(URL은 실제로 세션을 만든다)", async () => {
  const { hub, port, dataDir } = await startTestHub({ http: true });
  const client = new HubClient({ port, dataDir, hubEntry: "nonexistent.js" });
  let opened = "";
  try {
    await openViewer({ ticket: () => client.viewerTicket(), open: async (u) => { opened = u; } });
    const url = new URL(opened);
    assert.equal((await httpGet(Number(url.port), `/session?t=${url.hash.slice(3)}`)).status, 200);
  } finally { client.close(); hub.stop(); }
});

test("뷰어가 꺼진 Hub는 그 사유로 실패하고 열지 않는다", async () => {
  const { hub, port, dataDir } = await startTestHub();
  const client = new HubClient({ port, dataDir, hubEntry: "nonexistent.js" });
  let opened = false;
  try {
    await assert.rejects(openViewer({ ticket: () => client.viewerTicket(), open: async () => { opened = true; } }), /뷰어가 꺼져 있습니다/);
    assert.equal(opened, false);
  } finally { client.close(); hub.stop(); }
});

test("Hub가 이상한 URL을 주면 열지 않는다", async () => {
  let opened = false;
  await assert.rejects(
    openViewer({ ticket: async () => ({ ok: true, id: 1, url: "http://evil.example/#t=" + "a".repeat(64) }), open: async () => { opened = true; } }),
    /잘못된 뷰어 주소/,
  );
  assert.equal(opened, false);
});

test("브라우저 명령: win32는 explorer.exe 절대 경로", () => {
  const w = browserCommand("win32", "http://127.0.0.1:1/?t=x");
  assert.match(w.cmd, /explorer\.exe$/i);
  assert.deepEqual(w.args, ["http://127.0.0.1:1/?t=x"]);
  assert.equal(browserCommand("darwin", "u").cmd, "open");
  assert.equal(browserCommand("linux", "u").cmd, "xdg-open");
});
