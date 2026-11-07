// 망 엔진 시험 도구(시험 전용): 임시 폴더 노드와 메모리 연결.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tempDir } from "../../testing.js";
import { ChannelStore } from "../../channels.js";
import { generateSigningKeys, type SigningKeys } from "../../../shared/connCrypto.js";
import type { Channel, Message } from "../../../shared/protocol.js";
import { LinkChannel } from "./link.js";
import { Mesh, type MeshDeps } from "./mesh.js";

export interface Node {
  name: string;
  spaceId: string;
  keys: SigningKeys;
  dataDir: string;
  channels: ChannelStore;
  own: { id: string; name: string }[];
  mesh: Mesh;
  delivered: Message[];
  logs: string[];
  /** 내 채널 하나 만들기(망 공유 목록에도 넣음 — share=false면 안 넣음). */
  addChannel(name: string, share?: boolean): string;
  say(chId: string, text: string, from?: string): Message;
  restart(): void;
  mirror(origin: Node, chId: string): Message[];
}

export function node(name: string, spaceId: string, extra: Partial<MeshDeps> = {}): Node {
  const dataDir = tempDir(`mesh-${spaceId}-`);
  const keys = generateSigningKeys();
  const n = {} as Node;
  Object.assign(n, {
    name, spaceId, keys, dataDir, own: [], delivered: [], logs: [],
    channels: new ChannelStore({ dir: path.join(dataDir, "channels") }),
  });
  const make = () => new Mesh({
    dir: path.join(dataDir, "mesh"),
    self: () => ({ spaceId, spaceName: name, userName: `${name}님`, keys }),
    ownChannels: () => n.own,
    channels: n.channels,
    guard: (s) => s,
    log: (code) => n.logs.push(code),
    deliver: (_ch: Channel, m: Message) => n.delivered.push(m),
    ...extra,
  });
  n.mesh = make();
  n.addChannel = (chName, share = true) => {
    const id = randomUUID();
    n.channels.register({ id, kind: "server", label: `통신/${chName}`, members: null, area: "connection" }, path.join(dataDir, "comms", `${id}.jsonl`));
    if (share) { n.own.push({ id, name: chName }); n.mesh.ownChanged(); }
    return id;
  };
  n.say = (chId, text, from = "u1") => {
    const m = n.channels.append(chId, from, `${name}AI`, text);
    n.mesh.onOwnMessage(chId, m);
    return m;
  };
  n.restart = () => {
    n.mesh.stop();
    n.channels = new ChannelStore({ dir: path.join(dataDir, "channels") });
    for (const c of n.own) n.channels.register({ id: c.id, kind: "server", label: `통신/${c.name}`, members: null, area: "connection" }, path.join(dataDir, "comms", `${c.id}.jsonl`));
    n.mesh = make();
  };
  n.mirror = (origin, chId) => n.channels.recent(n.mesh.mirrorId(origin.spaceId, chId), 1000);
  return n;
}

/** 두 노드를 메모리 연결로 잇는다. 돌려주는 함수로 끊는다. */
export function connect(a: Node, b: Node, tap?: (from: "a" | "b", obj: any) => boolean): () => void {
  const [x, y] = LinkChannel.memoryPair(tap);
  a.mesh.attach({ spaceId: b.spaceId, spaceName: b.name, serverKey: b.keys.publicKeyB64 }, x);
  b.mesh.attach({ spaceId: a.spaceId, spaceName: a.name, serverKey: a.keys.publicKeyB64 }, y);
  return () => x.close();
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 메시지가 다 퍼지도록 잠깐 기다림(더 오지 않는지 볼 때). */
export const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
