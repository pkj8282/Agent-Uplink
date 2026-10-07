#!/usr/bin/env node
// Agent Uplink v2 — 계정/채널 기반 세션 간 통신 MCP 서버(stdio).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HubClient } from "./hubClient.js";
import { RoleStore, resolveRoleCwd } from "./roles.js";
import { AccountSession } from "./session.js";
import { oneLine } from "./text.js";
import { fmtItems, fmtMessages } from "./format.js";
import { resolveDataDir } from "../shared/clientKey.js";
import { currentLang } from "../shared/langConfig.js";
import { MAX_TEXT_LENGTH } from "../shared/protocol.js";
import { nameSchema } from "./schemas.js";
import { toolTexts } from "./tools.js";
import { mcpMsg, type McpKey } from "./messages.js";

// --- 계정 부트스트랩 ---
// UPLINK_ACCOUNT가 있으면 그 계정으로 고정(기존 동작). 없으면 use_account로 역할을 고를 때까지 로그인하지 않는다.
const pinnedUuid = process.env.UPLINK_ACCOUNT || undefined;
const dataDir = resolveDataDir(process.env);
const roles = pinnedUuid ? null : new RoleStore({ dataDir, cwd: resolveRoleCwd(process.env, process.cwd()), env: process.env.UPLINK_ACCOUNTS });
const client = new HubClient({
  port: Number(process.env.UPLINK_TCP_PORT ?? 47800),
  accountUuid: pinnedUuid,
  accountName: process.env.UPLINK_ACCOUNT_NAME,
  dataDir,
});
const session = new AccountSession(client, roles, pinnedUuid);

// 안내문·도구 설명은 시작 때의 언어로 한 번 등록한다(호스트가 시작 때 받아 둔다 — 언어 변경은 세션 재시작 후 반영).
// 응답 문구는 호출마다 현재 언어(m)로 만든다.
const REG_LANG = currentLang(dataDir);
const T = toolTexts(REG_LANG);
const m = (key: McpKey, params?: object) => mcpMsg(client.lang(), key, params);

const server = new McpServer({ name: "agent-uplink", version: "2.1.1" }, { instructions: T.instructions });

// 도구 성격 표시(클라이언트가 삭제 전 확인을 띄우는 등에 쓴다). 모두 로컬 전용이라 openWorld는 false.
const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SET: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DELETE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text" as const, text: t }], isError };
}

/** 계정이 필요한 툴: 역할 선택 전이면 안내를 돌려주고, 아니면 실행한다. */
function gated<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      const g = await session.guard();
      if (g) return text(g, true);
      return await fn(args);
    } catch (e) {
      return text((e as Error).message, true);
    }
  };
}

server.registerTool(
  "use_account",
  {
    description: T.tools.use_account.description,
    inputSchema: {
      role: z.string().max(200).optional().describe(T.tools.use_account.params.role),
      description: z.string().max(500).optional().describe(T.tools.use_account.params.description),
    },
    annotations: SET,
  },
  async ({ role, description }) => {
    try {
      if (role === undefined) return text(await session.listText());
      const r = await session.use(role, description);
      return text(r.text, !r.ok);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.registerTool(
  "whoami",
  {
    description: T.tools.whoami.description,
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try {
      const sel = session.selection;
      if (!sel) return text(`${m("not_selected_yet")}\n\n${await session.listText()}`);
      const r = await client.whoami();
      if (!r.ok) return text(session.explainError(r), true);
      const lines = [m("label_uuid", { uuid: r.uuid }), m("label_name", { name: r.name })];
      if (sel.role) lines.push(m("label_role", { role: sel.role }));
      else lines.push(m("pinned_label"));
      if (r.description) lines.push(m("label_description", { description: oneLine(r.description, 500) }));
      lines.push(m("default_channel"));
      return text(lines.join("\n"));
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.registerTool(
  "set_profile",
  {
    description: T.tools.set_profile.description,
    inputSchema: { description: z.string().max(500).describe(T.tools.set_profile.params.description) },
    annotations: SET,
  },
  gated(async ({ description }: { description: string }) => {
    const r = await client.setProfile(description);
    return r.ok ? text(m("profile_changed", { description: r.description || m("none_value") })) : text(session.explainError(r), true);
  }),
);

server.registerTool(
  "set_name",
  {
    description: T.tools.set_name.description,
    inputSchema: { name: nameSchema(T.tools.set_name.params.name, REG_LANG) },
    annotations: SET,
  },
  gated(async ({ name }: { name: string }) => {
    const r = await client.setName(name);
    return r.ok ? text(m("name_changed", { name: r.name })) : text(session.explainError(r), true);
  }),
);

server.registerTool(
  "list_accounts",
  {
    description: T.tools.list_accounts.description,
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try {
      const r = await session.accountsText();
      return text(r.text, !r.ok);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.registerTool(
  "open_dm",
  {
    description: T.tools.open_dm.description,
    inputSchema: { peer: z.string().min(1).max(256).describe(T.tools.open_dm.params.peer) },
    annotations: SET,
  },
  gated(async ({ peer }: { peer: string }) => {
    const r = await client.openDm(peer);
    return r.ok ? text(m("dm_opened", { channelId: r.channelId })) : text(session.explainError(r), true);
  }),
);

server.registerTool(
  "list_dms",
  {
    description: T.tools.list_dms.description,
    inputSchema: {},
    annotations: READ,
  },
  gated(async () => {
    const r = await client.listDms();
    if (!r.ok) return text(session.explainError(r), true);
    const list = (r.dms ?? []).map(
      (d) => `${oneLine(d.peerName, 80)}${d.peerOnline ? m("online_suffix") : ""} (${d.peer}) → ${d.channelId}${d.peerDescription ? ` — ${oneLine(d.peerDescription, 120)}` : ""}`,
    );
    return text(list.length ? list.join("\n") : m("no_dms"));
  }),
);

server.registerTool(
  "create_server",
  {
    description: T.tools.create_server.description,
    inputSchema: { name: nameSchema(T.tools.create_server.params.name, REG_LANG) },
    annotations: WRITE,
  },
  gated(async ({ name }: { name: string }) => {
    const r = await client.createServer(name);
    return r.ok ? text(m("server_created", { serverId: r.serverId })) : text(session.explainError(r), true);
  }),
);

server.registerTool(
  "list_servers",
  {
    description: T.tools.list_servers.description,
    inputSchema: {},
    annotations: READ,
  },
  gated(async () => {
    const r = await client.listServers();
    if (!r.ok) return text(session.explainError(r), true);
    const list = (r.servers ?? []).map((s) => `${s.name} (${s.serverId}) · ${m("server_channel_count", { count: s.channelCount })}`);
    return text(list.length ? list.join("\n") : m("no_servers"));
  }),
);

server.registerTool(
  "create_channel",
  {
    description: T.tools.create_channel.description,
    inputSchema: {
      serverId: z.string().min(1).max(256).describe(T.tools.create_channel.params.serverId),
      name: nameSchema(T.tools.create_channel.params.name, REG_LANG),
    },
    annotations: WRITE,
  },
  gated(async ({ serverId, name }: { serverId: string; name: string }) => {
    const r = await client.createChannel(serverId, name);
    return r.ok ? text(m("channel_created", { channelId: r.channelId })) : text(session.explainError(r), true);
  }),
);

server.registerTool(
  "list_channels",
  {
    description: T.tools.list_channels.description,
    inputSchema: { serverId: z.string().min(1).max(256).describe(T.tools.list_channels.params.serverId) },
    annotations: READ,
  },
  gated(async ({ serverId }: { serverId: string }) => {
    const r = await client.listChannels(serverId);
    if (!r.ok) return text(session.explainError(r), true);
    const list = (r.channels ?? []).map((c) => `${c.name} → ${c.channelId}`);
    return text(list.length ? list.join("\n") : m("no_channels"));
  }),
);

server.registerTool(
  "delete_channel",
  {
    description: T.tools.delete_channel.description,
    inputSchema: { channelId: z.string().min(1).max(256).describe(T.tools.delete_channel.params.channelId) },
    annotations: DELETE,
  },
  gated(async ({ channelId }: { channelId: string }) => {
    const r = await client.deleteChannel(channelId);
    return r.ok ? text(m("channel_deleted")) : text(session.explainError(r), true);
  }),
);

server.registerTool(
  "delete_server",
  {
    description: T.tools.delete_server.description,
    inputSchema: { serverId: z.string().min(1).max(256).describe(T.tools.delete_server.params.serverId) },
    annotations: DELETE,
  },
  gated(async ({ serverId }: { serverId: string }) => {
    const r = await client.deleteServer(serverId);
    return r.ok ? text(m("server_deleted")) : text(session.explainError(r), true);
  }),
);

server.registerTool(
  "send",
  {
    description: T.tools.send.description,
    inputSchema: {
      channelId: z.string().min(1).max(256).describe(T.tools.send.params.channelId),
      text: z.string().min(1).max(MAX_TEXT_LENGTH).describe(T.tools.send.params.text),
    },
    annotations: WRITE,
  },
  gated(async ({ channelId, text: body }: { channelId: string; text: string }) => {
    const r = await client.send(channelId, body);
    return r.ok ? text(m("sent", { seq: r.seq })) : text(session.explainError(r), true);
  }),
);

server.registerTool(
  "read",
  {
    description: T.tools.read.description,
    inputSchema: {
      channelId: z.string().min(1).max(256).describe(T.tools.read.params.channelId),
      limit: z.number().int().positive().max(500).optional().describe(T.tools.read.params.limit),
    },
    annotations: READ,
  },
  gated(async ({ channelId, limit }: { channelId: string; limit?: number }) => {
    const r = await client.read(channelId, limit);
    return r.ok ? text(fmtMessages(r.messages, client.lang())) : text(session.explainError(r), true);
  }),
);

server.registerTool(
  "check",
  {
    description: T.tools.check.description,
    inputSchema: {},
    annotations: WRITE,
  },
  gated(async () => {
    const r = await client.check();
    return r.ok ? text(fmtItems(r.items, client.lang())) : text(session.explainError(r), true);
  }),
);

server.registerTool(
  "wait",
  {
    description: T.tools.wait.description,
    inputSchema: { timeoutMs: z.number().int().positive().max(120000).optional().describe(T.tools.wait.params.timeoutMs) },
    annotations: WRITE,
  },
  gated(async ({ timeoutMs }: { timeoutMs?: number }) => {
    const r = await client.wait(timeoutMs ?? 30000);
    return r.ok ? text(fmtItems(r.items, client.lang())) : text(session.explainError(r), true);
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${pinnedUuid ? m("mcp_started_pinned", { account: pinnedUuid }) : m("mcp_started_unselected")}\n`);
}
main().catch((e) => { process.stderr.write(`${m("mcp_fatal", { detail: (e as Error).message })}\n`); process.exit(1); });
