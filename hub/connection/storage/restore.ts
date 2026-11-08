// 다른 PC 복원(v3.0 7단계): 저장소의 통신 대화 백업을 복구 키로 찾아 검증·복호해 돌려준다. 저장소에는 쓰지 않는다.
// 경로: agent-uplink/<spaceId>/<hubId>/<UTC 날짜>/<번호8>.frag (업로더와 같음). 방식 1 공간(agent-uplink/s1/…)은 대상이 아니다.
// 한 Hub 폴더의 조각은 모두 같은 Hub 키여야 하고 hubId = sha256(Hub 키) 앞 16자와 맞아야 한다(다른 Hub 조각 끼워 넣기 차단).
import { openEnvelope } from "../../../shared/signed.js";
import { createHash } from "node:crypto";
import { checkChain, decodeFragment, type FragmentError } from "../../../shared/archive.js";
import { fromBase32 } from "../../../shared/connCrypto.js";
import type { Message } from "../../../shared/protocol.js";
import type { StorageBackend } from "./backend.js";

const ROOT = "agent-uplink";
const SKIP = new Set(["s1"]);
const MAX_SPACES = 100;
const MAX_HUBS = 100;
const SCAN_TRIES = 5;

export interface BackupCandidate {
  spaceId: string;
  hubId: string;
  fragments: number;
  firstDay: string;
  lastDay: string;
}

export interface RestoredChannel {
  oldId: string;
  /** 조각에 든 채널 이름(옛 조각뿐이면 null). */
  name: string | null;
  messages: Message[];
}

export interface RestoreResult {
  channels: RestoredChannel[];
  fragments: number;
  messages: number;
  /** 사슬이 이어지지 않은 조각 번호. */
  breaks: number[];
  /** 마지막 번호 파일과의 비교: ok / behind(최근 조각이 없음) / missing(파일이 없거나 서명이 틀림). */
  head: "ok" | "behind" | "missing";
  /** 찾은 가장 큰 조각 번호(없으면 -1)와 그 Hub 키 — 망의 기억과 맞춰 보는 데 쓴다. */
  lastIndex: number;
  hubKey: string;
  /** 들여오지 않은 조각(서명·복호·Hub 불일치). */
  bad: { path: string; code: FragmentError | "frag_space_mismatch" }[];
}

/** 복구 키(base32, 4자 묶음): 대소문자·줄표·공백 무시. 공간 열쇠 32바이트가 아니면 null. */
export function parseRecoveryKey(s: string): Buffer | null {
  if (typeof s !== "string") return null;
  const b = fromBase32(s.replace(/\s/g, ""));
  return b && b.length === 32 ? b : null;
}

const hubIdOf = (hubKey: string) => createHash("sha256").update(hubKey).digest("hex").slice(0, 16);

async function fragmentPaths(backend: StorageBackend, dir: string): Promise<{ days: string[]; paths: string[] }> {
  const days = (await backend.list(dir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const paths: string[] = [];
  for (const day of days) for (const name of (await backend.list(`${dir}/${day}`)).filter((n) => /^\d{8}\.frag$/.test(n)).sort()) paths.push(`${dir}/${day}/${name}`);
  return { days, paths };
}

/** 복구 키로 풀리는 백업(Hub 폴더)들. */
export async function scanBackups(backend: StorageBackend, spaceKey: Buffer): Promise<BackupCandidate[]> {
  const out: BackupCandidate[] = [];
  for (const spaceId of (await backend.list(ROOT)).filter((s) => !SKIP.has(s)).slice(0, MAX_SPACES)) {
    for (const hubId of (await backend.list(`${ROOT}/${spaceId}`)).slice(0, MAX_HUBS)) {
      const dir = `${ROOT}/${spaceId}/${hubId}`;
      const { days, paths } = await fragmentPaths(backend, dir);
      let opens = false;
      for (const p of paths.slice(0, SCAN_TRIES)) {
        const bytes = await backend.get(p);
        const d = bytes ? decodeFragment(bytes, { spaceKey }) : null;
        if (d?.ok && d.header.spaceId === spaceId && hubIdOf(d.header.hubKey) === hubId) { opens = true; break; }
      }
      if (opens) out.push({ spaceId, hubId, fragments: paths.length, firstDay: days[0] ?? "", lastDay: days[days.length - 1] ?? "" });
    }
  }
  return out;
}

/** 서명한 마지막 번호 파일과 찾은 조각을 맞춰 본다. 저장소 쓰기 권한자가 파일과 조각을 함께 되돌리면 이것만으로는 못 잡는다. */
async function checkHead(backend: StorageBackend, dir: string, spaceId: string, hubKey: string | undefined, good: { index: number; hash: string }[], lastIndex: number): Promise<RestoreResult["head"]> {
  if (!hubKey) return "missing";
  const raw = await backend.get(`${dir}/head.json`).catch(() => null);
  if (!raw) return "missing";
  const env = openEnvelope(raw.toString("utf8"), hubKey);
  if (!env.ok) return "missing";
  const b = env.body as { k?: unknown; spaceId?: unknown; hubKey?: unknown; index?: unknown; hash?: unknown };
  if (b.k !== "backup-head" || b.spaceId !== spaceId || b.hubKey !== hubKey || !Number.isSafeInteger(b.index) || typeof b.hash !== "string") return "missing";
  if ((b.index as number) > lastIndex) return "behind";
  const at = good.find((g) => g.index === b.index);
  return at && at.hash !== b.hash ? "behind" : "ok";
}

/** 한 백업을 받아 검증·복호한다. 서명·복호·Hub가 맞지 않는 조각은 빼고 보고한다. */
export async function restoreBackup(backend: StorageBackend, spaceKey: Buffer, target: { spaceId: string; hubId: string }): Promise<RestoreResult> {
  const dir = `${ROOT}/${target.spaceId}/${target.hubId}`;
  const { paths } = await fragmentPaths(backend, dir);
  const bad: RestoreResult["bad"] = [];
  const good: { index: number; prevHash: string; hash: string; prevIndex?: number; messages: Message[]; channels: { id: string; name: string }[] }[] = [];
  let hubKey: string | undefined;
  for (const p of paths) {
    const bytes = await backend.get(p);
    if (!bytes) continue;
    const d = decodeFragment(bytes, { spaceKey, ...(hubKey ? { expectHubKey: hubKey } : {}) });
    if (!d.ok) { bad.push({ path: p, code: d.code }); continue; }
    if (d.header.spaceId !== target.spaceId) { bad.push({ path: p, code: "frag_space_mismatch" }); continue; }
    if (hubIdOf(d.header.hubKey) !== target.hubId) { bad.push({ path: p, code: "frag_hub_mismatch" }); continue; }
    hubKey ??= d.header.hubKey;
    good.push({ index: d.header.index, prevHash: d.header.prevHash, hash: d.hash, ...(d.header.prevIndex !== undefined ? { prevIndex: d.header.prevIndex } : {}), messages: d.body.messages, channels: d.body.channels ?? [] });
  }
  const breaks = checkChain(good).breaks;
  good.sort((a, b) => a.index - b.index);
  const byChannel = new Map<string, { name: string | null; seen: Set<number>; messages: Message[] }>();
  const seenIndex = new Set<number>();
  let messages = 0;
  for (const g of good) {
    if (seenIndex.has(g.index)) continue; // 같은 번호가 둘(갈라짐)이면 처음 것만 — breaks에 보고됨
    seenIndex.add(g.index);
    for (const c of g.channels) {
      const e = byChannel.get(c.id) ?? { name: null, seen: new Set(), messages: [] };
      e.name = c.name; // 뒤 조각의 이름이 최신
      byChannel.set(c.id, e);
    }
    for (const m of g.messages) {
      if (!m || typeof m.channelId !== "string" || typeof m.seq !== "number" || typeof m.text !== "string") continue;
      const e = byChannel.get(m.channelId) ?? { name: null, seen: new Set<number>(), messages: [] };
      byChannel.set(m.channelId, e);
      if (e.seen.has(m.seq)) continue;
      e.seen.add(m.seq);
      e.messages.push(m);
      messages++;
    }
  }
  const channels: RestoredChannel[] = [...byChannel].filter(([, e]) => e.messages.length > 0).map(([oldId, e]) => ({ oldId, name: e.name, messages: e.messages.sort((a, b) => a.seq - b.seq) }));
  const lastIndex = good.length ? Math.max(...good.map((g) => g.index)) : -1;
  return { channels, fragments: seenIndex.size, messages, breaks, bad, lastIndex, hubKey: hubKey ?? "", head: await checkHead(backend, dir, target.spaceId, hubKey, good, lastIndex) };
}
