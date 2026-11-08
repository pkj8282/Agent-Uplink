// 망 엔진 시험 도구(시험 전용): 임시 폴더 노드와 메모리 연결.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tempDir } from "../../testing.js";
import { ChannelStore } from "../../channels.js";
import { generateSigningKeys, type SigningKeys } from "../../../shared/connCrypto.js";
import type { Channel, Message } from "../../../shared/protocol.js";
import { LinkChannel } from "./link.js";
import { Mesh, type MeshDeps } from "./mesh.js";
import { Governance } from "./governance.js";

/** 시험 키 → 공간 ID(실제 Hub는 키 지문에서 뽑는다). 악의 서버 시험은 자기 키를 자기 ID로 등록한다. */
export const KEY_IDS = new Map<string, string>();
export function registerKey(spaceId: string, keyB64: string): void { KEY_IDS.set(keyB64, spaceId); }

export interface Node {
  name: string;
  spaceId: string;
  keys: SigningKeys;
  dataDir: string;
  channels: ChannelStore;
  own: { id: string; name: string }[];
  mesh: Mesh;
  gov?: Governance;
  delivered: Message[];
  logs: string[];
  /** 내 채널 하나 만들기(망 공유 목록에도 넣음 — share=false면 안 넣음). */
  addChannel(name: string, share?: boolean): string;
  say(chId: string, text: string, from?: string): Message;
  restart(): void;
  mirror(origin: Node, chId: string): Message[];
}

export function node(name: string, spaceId: string, extra: Partial<MeshDeps> = {}, opts: { gov?: boolean; manual?: boolean } = {}): Node {
  const dataDir = tempDir(`mesh-${spaceId}-`);
  const keys = generateSigningKeys();
  registerKey(spaceId, keys.publicKeyB64);
  const n = {} as Node;
  Object.assign(n, {
    name, spaceId, keys, dataDir, own: [], delivered: [], logs: [],
    channels: new ChannelStore({ dir: path.join(dataDir, "channels") }),
  });
  const makeGov = () => new Governance({
    dir: path.join(dataDir, "mesh"),
    self: () => ({ spaceId, spaceName: name, userName: `${name}-u`, keys }),
    mesh: () => n.mesh,
    unshareOwn: (ch) => { n.own = n.own.filter((c) => c.id !== ch); n.mesh.ownChanged(); },
    log: (code) => n.logs.push(code),
  });
  const make = () => new Mesh({
    dir: path.join(dataDir, "mesh"),
    self: () => ({ spaceId, spaceName: name, userName: `${name}-u`, keys }),
    ownChannels: () => n.own,
    channels: n.channels,
    guard: (s) => s,
    log: (code) => n.logs.push(code),
    originOf: (k: string) => KEY_IDS.get(k),
    deliver: (_ch: Channel, m: Message) => n.delivered.push(m),
    // 인정 절차를 시험하지 않는 시험은 후보를 바로 승인한다(manual이면 시험이 직접)
    onCandidate: (origin: string) => { if (!opts.manual) n.mesh.acceptServer(origin); },
    appendOwn: (ch, from, fromName, text, origin) => (n.channels.getChannel(ch) ? n.channels.append(ch, from, fromName, text, origin) : null),
    ...(opts.gov ? {
      policy: { blocked: (id: string) => n.gov!.blocked(id), channelBlocked: (o: string, c: string) => n.gov!.channelBlocked(o, c), noWrite: (e: string, h: string) => n.gov!.noWrite(e, h) },
      onOtherEvent: (e: { event: string }, l: Parameters<NonNullable<MeshDeps["onOtherEvent"]>>[1]) => n.gov!.onEvent(e, l),
      onAttach: (l: Parameters<NonNullable<MeshDeps["onAttach"]>>[0]) => n.gov!.onAttach(l),
      initialWindow: () => n.gov!.initialWindow(),
    } : {}),
    ...extra,
  });
  n.mesh = make();
  if (opts.gov) n.gov = makeGov();
  n.addChannel = (chName, share = true) => {
    const id = randomUUID();
    n.channels.register({ id, kind: "server", label: `comms/${chName}`, members: null, area: "connection" }, path.join(dataDir, "comms", `${id}.jsonl`));
    if (share) { n.own.push({ id, name: chName }); n.mesh.ownChanged(); }
    return id;
  };
  n.say = (chId, text, from = "u1") => {
    const m = n.channels.append(chId, from, `${name}-ai`, text);
    n.mesh.onOwnMessage(chId, m);
    return m;
  };
  n.restart = () => {
    n.mesh.stop();
    n.channels = new ChannelStore({ dir: path.join(dataDir, "channels") });
    for (const c of n.own) n.channels.register({ id: c.id, kind: "server", label: `comms/${c.name}`, members: null, area: "connection" }, path.join(dataDir, "comms", `${c.id}.jsonl`));
    n.mesh = make();
    if (opts.gov) n.gov = makeGov();
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

export async function until(cond: () => boolean, ms = 10_000): Promise<void> { // CI 러너는 느리다 — 조건이 맞으면 바로 끝나므로 넉넉히
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 메시지가 다 퍼지도록 잠깐 기다림(더 오지 않는지 볼 때). */
export const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
