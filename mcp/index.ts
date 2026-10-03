// Agent Uplink v2 — 계정/채널 기반 세션 간 통신 MCP 서버(stdio).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HubClient } from "./hubClient.js";
import { InboxItem, Message } from "../shared/protocol.js";

// --- 계정 부트스트랩 ---
function resolveAccount(): { uuid: string; name?: string; pinned: boolean } {
  const name = process.env.UPLINK_ACCOUNT_NAME;
  const envUuid = process.env.UPLINK_ACCOUNT;
  if (envUuid) return { uuid: envUuid, name, pinned: true };
  const base = process.env.UPLINK_DATA_DIR ?? path.join(process.env.PROGRAMDATA ?? ".", "AgentUplink");
  const stateFile = path.join(base, "state", "mcp-account");
  try {
    const saved = fs.readFileSync(stateFile, "utf8").trim();
    if (saved) return { uuid: saved, name, pinned: false };
  } catch {
    // 없음 → 생성
  }
  const uuid = randomUUID();
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, uuid);
  } catch {
    // 저장 실패해도 이번 세션은 이 uuid로 동작
  }
  return { uuid, name, pinned: false };
}

const account = resolveAccount();
const client = new HubClient({
  port: Number(process.env.UPLINK_TCP_PORT ?? 47800),
  accountUuid: account.uuid,
  accountName: account.name,
});

const server = new McpServer({ name: "agent-uplink", version: "2.0.0" });

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], isError };
}
function fmtItems(items: InboxItem[] | undefined): string {
  if (!items || items.length === 0) return "(새 메시지 없음)";
  return items.map((i) => `[#${i.channelLabel} ${i.fromName}] ${i.text}`).join("\n");
}
function fmtMessages(msgs: Message[] | undefined): string {
  if (!msgs || msgs.length === 0) return "(메시지 없음)";
  return msgs.map((m) => `[${new Date(m.ts).toLocaleTimeString()} ${m.fromName}] ${m.text}`).join("\n");
}

server.tool(
  "whoami",
  "내 계정(UUID·이름)을 봅니다. UUID가 env로 고정되지 않았으면 영구·양도를 위해 고정하라고 안내합니다. 1단계에서는 'lobby' 채널로 전체에게 보낼 수 있습니다.",
  {},
  async () => {
    try {
      const r = await client.whoami();
      if (!r.ok) return text(`조회 실패: ${r.error}`, true);
      const pin = account.pinned
        ? ""
        : `\n(주의: 이 UUID는 고정되지 않았습니다. 영구·양도하려면 MCP 설정 env에 UPLINK_ACCOUNT="${r.uuid}" 를 추가하세요.)`;
      return text(`계정 UUID: ${r.uuid}\n이름: ${r.name}\n기본 채널: lobby${pin}`);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "set_name",
  "내 계정 표시 이름을 바꿉니다.",
  { name: z.string().min(1).describe("새 표시 이름") },
  async ({ name }) => {
    try {
      const r = await client.setName(name);
      return r.ok ? text(`이름 변경: ${r.name}`) : text(`실패: ${r.error}`, true);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "list_accounts",
  "현재 알려진 계정 목록(디렉터리)을 봅니다.",
  {},
  async () => {
    try {
      const r = await client.listAccounts();
      if (!r.ok) return text(`실패: ${r.error}`, true);
      const list = (r.accounts ?? []).map((a) => `${a.name} (${a.uuid})`);
      return text(list.length ? list.join("\n") : "(계정 없음)");
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "open_dm",
  "상대 계정과의 1:1 Direct Message 채널을 엽니다(이미 있으면 그 채널). 반환된 channelId로 send/read 하세요. peer는 상대의 계정 UUID 또는 (유일할 때) 표시 이름입니다.",
  { peer: z.string().min(1).describe("상대 계정 UUID 또는 유일한 표시 이름") },
  async ({ peer }) => {
    try {
      const r = await client.openDm(peer);
      return r.ok ? text(`DM 채널 열림: ${r.channelId}`) : text(`실패: ${r.error}`, true);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "list_dms",
  "내 DM 목록(상대 → 채널ID)을 봅니다.",
  {},
  async () => {
    try {
      const r = await client.listDms();
      if (!r.ok) return text(`실패: ${r.error}`, true);
      const list = (r.dms ?? []).map((d) => `${d.peerName} (${d.peer}) → ${d.channelId}`);
      return text(list.length ? list.join("\n") : "(DM 없음)");
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "create_server",
  "새 Communication Server를 만듭니다(모든 계정에게 공개). 반환된 serverId로 채널을 만드세요.",
  { name: z.string().min(1).describe("서버 이름") },
  async ({ name }) => {
    try {
      const r = await client.createServer(name);
      return r.ok ? text(`서버 생성됨: ${r.serverId}`) : text(`실패: ${r.error}`, true);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "list_servers",
  "모든 Communication Server 목록(서버ID·이름·채널 수)을 봅니다.",
  {},
  async () => {
    try {
      const r = await client.listServers();
      if (!r.ok) return text(`실패: ${r.error}`, true);
      const list = (r.servers ?? []).map((s) => `${s.name} (${s.serverId}) · 채널 ${s.channelCount}개`);
      return text(list.length ? list.join("\n") : "(서버 없음)");
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "create_channel",
  "서버 안에 새 채널을 만듭니다(서버당 상한 있음). 반환된 channelId로 send/read 하세요.",
  { serverId: z.string().min(1).describe("대상 서버 ID"), name: z.string().min(1).describe("채널 이름") },
  async ({ serverId, name }) => {
    try {
      const r = await client.createChannel(serverId, name);
      return r.ok ? text(`채널 생성됨: ${r.channelId}`) : text(`실패: ${r.error}`, true);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "list_channels",
  "한 서버의 채널 목록(채널ID·이름)을 봅니다.",
  { serverId: z.string().min(1).describe("서버 ID") },
  async ({ serverId }) => {
    try {
      const r = await client.listChannels(serverId);
      if (!r.ok) return text(`실패: ${r.error}`, true);
      const list = (r.channels ?? []).map((c) => `${c.name} → ${c.channelId}`);
      return text(list.length ? list.join("\n") : "(채널 없음)");
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "delete_channel",
  "채널을 삭제합니다(개발용: allowDevDelete가 켜져 있을 때만 동작).",
  { channelId: z.string().min(1).describe("삭제할 채널 ID") },
  async ({ channelId }) => {
    try {
      const r = await client.deleteChannel(channelId);
      return r.ok ? text("채널 삭제됨") : text(`실패: ${r.error}`, true);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "delete_server",
  "서버를 삭제합니다(개발용: allowDevDelete가 켜져 있을 때만 동작).",
  { serverId: z.string().min(1).describe("삭제할 서버 ID") },
  async ({ serverId }) => {
    try {
      const r = await client.deleteServer(serverId);
      return r.ok ? text("서버 삭제됨") : text(`실패: ${r.error}`, true);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "send",
  "채널에 메시지를 보냅니다. 1단계에서는 channelId='lobby'로 전체에게 보냅니다(DM·서버 채널은 이후 단계).",
  { channelId: z.string().min(1).describe("대상 채널 ID (예: lobby)"), text: z.string().min(1).describe("보낼 내용") },
  async ({ channelId, text: body }) => {
    try {
      const r = await client.send(channelId, body);
      return r.ok ? text(`전송됨 (seq=${r.seq})`) : text(`전송 실패: ${r.error}`, true);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "read",
  "특정 채널의 최근 메시지 이력을 봅니다(인박스 커서를 바꾸지 않음).",
  { channelId: z.string().min(1).describe("채널 ID"), limit: z.number().int().positive().max(500).optional().describe("최근 N개(기본 50)") },
  async ({ channelId, limit }) => {
    try {
      const r = await client.read(channelId, limit);
      return r.ok ? text(fmtMessages(r.messages)) : text(`실패: ${r.error}`, true);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "check",
  "내 인박스의 새 메시지(모든 채널)를 즉시 가져옵니다. 채널 태그와 함께 반환하고 커서를 전진시킵니다.",
  {},
  async () => {
    try {
      const r = await client.check();
      return r.ok ? text(fmtItems(r.items)) : text(`실패: ${r.error}`, true);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "wait",
  "새 메시지가 올 때까지 최대 timeoutMs 대기(롱폴). 타임아웃이면 빈 결과.",
  { timeoutMs: z.number().int().positive().max(120000).optional().describe("최대 대기(ms), 기본 30000") },
  async ({ timeoutMs }) => {
    try {
      const r = await client.wait(timeoutMs ?? 30000);
      return r.ok ? text(fmtItems(r.items)) : text(`실패: ${r.error}`, true);
    } catch (e) { return text((e as Error).message, true); }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`Agent-Uplink v2 MCP 시작(stdio). account=${account.uuid}${account.pinned ? "" : " (미고정)"}\n`);
}
main().catch((e) => { process.stderr.write(`치명적 오류: ${(e as Error).message}\n`); process.exit(1); });
