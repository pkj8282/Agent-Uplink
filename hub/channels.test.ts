import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelStore } from "./channels.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-ch-")); }

test("register한 채널에 append하면 seq가 채널별로 1부터 증가한다", () => {
  const s = new ChannelStore({ dir: tmp() });
  s.register({ id: "lobby", kind: "server", label: "main/lobby", members: null });
  assert.equal(s.append("lobby", "u1", "A", "첫").seq, 1);
  assert.equal(s.append("lobby", "u2", "B", "둘").seq, 2);
});

test("채널마다 seq가 독립이다", () => {
  const s = new ChannelStore({ dir: tmp() });
  s.register({ id: "lobby", kind: "server", label: "l", members: null });
  s.register({ id: "dmX", kind: "dm", label: "A-B", members: ["u1", "u2"] });
  s.append("lobby", "u1", "A", "x");
  assert.equal(s.append("dmX", "u1", "A", "y").seq, 1);
});

test("recent는 최근 N개를 순서대로 준다", () => {
  const s = new ChannelStore({ dir: tmp(), ringSize: 3 });
  s.register({ id: "lobby", kind: "server", label: "l", members: null });
  for (let i = 1; i <= 5; i++) s.append("lobby", "u1", "A", "m" + i);
  assert.deepEqual(s.recent("lobby", 10).map((m) => m.text), ["m3", "m4", "m5"]);
});

test("register는 JSONL에서 seq와 메시지를 복원한다", () => {
  const dir = tmp();
  const s1 = new ChannelStore({ dir });
  s1.register({ id: "lobby", kind: "server", label: "l", members: null });
  s1.append("lobby", "u1", "A", "영속");
  const s2 = new ChannelStore({ dir });
  s2.register({ id: "lobby", kind: "server", label: "l", members: null });
  assert.equal(s2.recent("lobby", 10).length, 1);
  assert.equal(s2.append("lobby", "u1", "A", "다음").seq, 2);
});

test("없는 채널에 append하면 예외를 던진다", () => {
  const s = new ChannelStore({ dir: tmp() });
  assert.throws(() => s.append("nope", "u1", "A", "x"), /채널/);
});

test("unregister한 채널은 getChannel에서 사라지고 append가 거부된다", () => {
  const s = new ChannelStore({ dir: tmp() });
  s.register({ id: "c1", kind: "server", label: "A/c", members: null });
  s.append("c1", "u1", "A", "x");
  assert.equal(s.unregister("c1"), true);
  assert.equal(s.getChannel("c1"), undefined);
  assert.throws(() => s.append("c1", "u1", "A", "y"), /채널/);
});
