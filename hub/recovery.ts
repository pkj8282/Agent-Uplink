// 시작 시 손상 복구: dm/index.json을 계정 역색인으로 재구성한다.
import fs from "node:fs";
import { AccountStore } from "./accounts.js";
import { DmStore, DmRecord } from "./dm.js";
import { ChannelStore } from "./channels.js";

function logInfo(channels: ChannelStore, id: string): { exists: boolean; mtime: number } {
  try {
    return { exists: true, mtime: fs.statSync(channels.pathOf("dm", id)).mtimeMs };
  } catch {
    return { exists: false, mtime: 0 };
  }
}

/**
 * 각 계정의 dm[peer] = channelId로 레코드를 만든다. 같은 쌍에 channelId가 여럿이면
 * 로그가 있는 쪽, 둘 다 있으면 최근 수정된 쪽을 채택(나머지는 고아 정리로 휴지통행). 만든 수를 반환.
 */
export function rebuildDmIndex(accounts: AccountStore, dm: DmStore, channels: ChannelStore): number {
  const byPair = new Map<string, DmRecord>();
  const nameOf = (u: string) => accounts.get(u)?.name ?? u.slice(0, 8);
  for (const uuid of accounts.allUuids()) {
    const a = accounts.get(uuid)!;
    for (const [peer, channelId] of Object.entries(a.dm)) {
      const key = [uuid, peer].sort().join("|");
      const cand: DmRecord = { channelId, members: [uuid, peer], label: `${nameOf(uuid)}-${nameOf(peer)}` };
      const cur = byPair.get(key);
      if (!cur) {
        byPair.set(key, cand);
        continue;
      }
      if (cur.channelId === channelId) continue;
      const c = logInfo(channels, cur.channelId);
      const n = logInfo(channels, channelId);
      if ((n.exists && !c.exists) || (n.exists && c.exists && n.mtime > c.mtime)) byPair.set(key, cand);
    }
  }
  const recs = [...byPair.values()];
  dm.replaceAll(recs);
  return recs.length;
}
