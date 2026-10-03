// Agent Uplink v2 — 계정/채널 기반 세션 간 통신 MCP 서버(stdio).
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HubClient } from "./hubClient.js";
import { RoleStore } from "./roles.js";
import { AccountSession } from "./session.js";
import { InboxItem, Message } from "../shared/protocol.js";

// --- 계정 부트스트랩 ---
// UPLINK_ACCOUNT가 있으면 그 계정으로 고정(기존 동작). 없으면 use_account로 역할을 고를 때까지 로그인하지 않는다.
const pinnedUuid = process.env.UPLINK_ACCOUNT || undefined;
const dataDir = process.env.UPLINK_DATA_DIR ?? path.join(process.env.PROGRAMDATA ?? ".", "AgentUplink");
const roles = pinnedUuid ? null : new RoleStore({ dataDir, cwd: process.cwd(), env: process.env.UPLINK_ACCOUNTS });
const client = new HubClient({
  port: Number(process.env.UPLINK_TCP_PORT ?? 47800),
  accountUuid: pinnedUuid,
  accountName: process.env.UPLINK_ACCOUNT_NAME,
});
const session = new AccountSession(client, roles, pinnedUuid);

const INSTRUCTIONS =
  "Agent-Uplink: 로컬 AI 세션 간 메시지 도구입니다. 세션을 시작하면 먼저 use_account(인자 없이)로 이 폴더의 역할 목록을 보고, " +
  "자기 역할을 골라 use_account(role)을 호출하세요(처음 만드는 역할이면 description으로 역할 설명을 남기세요). " +
  "그다음 send/check/wait 등으로 대화합니다. 상대가 누구인지는 list_accounts로 설명과 함께 볼 수 있습니다.";

const server = new McpServer({ name: "agent-uplink", version: "2.1.0" }, { instructions: INSTRUCTIONS });

type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };

function text(t: string, isError = false): ToolResult {
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

server.tool(
  "use_account",
  "이 세션의 계정(역할)을 선택합니다. 인자 없이 호출하면 이 폴더의 역할 목록(설명·사용 중 여부)을 봅니다. role을 주면 그 역할 계정으로 로그인합니다(없으면 새로 만듦). 같은 역할은 재시작 후에도 같은 계정입니다. 다른 세션이 쓰는 역할은 고를 수 없습니다.",
  {
    role: z.string().optional().describe("역할 이름(예: 기획, 구현). 생략하면 목록만 봅니다."),
    description: z.string().max(500).optional().describe("역할 설명(프로필). 다른 세션·관리 도구에 보입니다."),
  },
  async ({ role, description }) => {
    try {
      if (role === undefined) return text(await session.listText());
      const r = await session.use(role, description);
      return text(r.text, !r.ok);
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "whoami",
  "내 계정(UUID·이름·역할·설명)을 봅니다. 아직 역할을 고르지 않았으면 역할 목록을 보여줍니다.",
  {},
  async () => {
    try {
      const sel = session.selection;
      if (!sel) return text(`아직 계정을 선택하지 않았습니다. use_account(role)로 고르세요.\n\n${await session.listText()}`);
      const r = await client.whoami();
      if (!r.ok) return text(`조회 실패: ${r.error}`, true);
      const lines = [`계정 UUID: ${r.uuid}`, `이름: ${r.name}`];
      if (sel.role) lines.push(`역할: ${sel.role}`);
      else lines.push("고정: UPLINK_ACCOUNT");
      if (r.description) lines.push(`설명: ${r.description}`);
      lines.push("기본 채널: lobby");
      return text(lines.join("\n"));
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "set_profile",
  "내 계정의 프로필 설명을 바꿉니다(최대 500자, 빈 문자열이면 삭제). 다른 세션·관리 도구·뷰어에 보입니다.",
  { description: z.string().max(500).describe("역할 설명") },
  gated(async ({ description }: { description: string }) => {
    const r = await client.setProfile(description);
    return r.ok ? text(`설명 변경: ${r.description || "(없음)"}`) : text(`실패: ${r.error}`, true);
  }),
);

server.tool(
  "set_name",
  "내 계정 표시 이름을 바꿉니다.",
  { name: z.string().min(1).describe("새 표시 이름") },
  gated(async ({ name }: { name: string }) => {
    const r = await client.setName(name);
    return r.ok ? text(`이름 변경: ${r.name}`) : text(`실패: ${r.error}`, true);
  }),
);

server.tool(
  "list_accounts",
  "현재 알려진 계정 목록(이름·접속 여부·설명)을 봅니다. 역할을 고르기 전에도 쓸 수 있습니다.",
  {},
  async () => {
    try {
      const r = await client.listAccounts();
      if (!r.ok) return text(`실패: ${r.error}`, true);
      const list = (r.accounts ?? []).map(
        (a) => `${a.name}${a.online ? " (접속 중)" : ""} (${a.uuid})${a.description ? ` — ${a.description}` : ""}`,
      );
      return text(list.length ? list.join("\n") : "(계정 없음)");
    } catch (e) { return text((e as Error).message, true); }
  },
);

server.tool(
  "open_dm",
  "상대 계정과의 1:1 Direct Message 채널을 엽니다(이미 있으면 그 채널). 반환된 channelId로 send/read 하세요. peer는 상대의 계정 UUID 또는 (유일할 때) 표시 이름입니다.",
  { peer: z.string().min(1).describe("상대 계정 UUID 또는 유일한 표시 이름") },
  gated(async ({ peer }: { peer: string }) => {
    const r = await client.openDm(peer);
    return r.ok ? text(`DM 채널 열림: ${r.channelId}`) : text(`실패: ${r.error}`, true);
  }),
);

server.tool(
  "list_dms",
  "내 DM 목록(상대·접속 여부·설명 → 채널ID)을 봅니다.",
  {},
  gated(async () => {
    const r = await client.listDms();
    if (!r.ok) return text(`실패: ${r.error}`, true);
    const list = (r.dms ?? []).map(
      (d) => `${d.peerName}${d.peerOnline ? " (접속 중)" : ""} (${d.peer}) → ${d.channelId}${d.peerDescription ? ` — ${d.peerDescription}` : ""}`,
    );
    return text(list.length ? list.join("\n") : "(DM 없음)");
  }),
);

server.tool(
  "create_server",
  "새 Communication Server를 만듭니다(모든 계정에게 공개). 반환된 serverId로 채널을 만드세요.",
  { name: z.string().min(1).describe("서버 이름") },
  gated(async ({ name }: { name: string }) => {
    const r = await client.createServer(name);
    return r.ok ? text(`서버 생성됨: ${r.serverId}`) : text(`실패: ${r.error}`, true);
  }),
);

server.tool(
  "list_servers",
  "모든 Communication Server 목록(서버ID·이름·채널 수)을 봅니다.",
  {},
  gated(async () => {
    const r = await client.listServers();
    if (!r.ok) return text(`실패: ${r.error}`, true);
    const list = (r.servers ?? []).map((s) => `${s.name} (${s.serverId}) · 채널 ${s.channelCount}개`);
    return text(list.length ? list.join("\n") : "(서버 없음)");
  }),
);

server.tool(
  "create_channel",
  "서버 안에 새 채널을 만듭니다(서버당 상한 있음). 반환된 channelId로 send/read 하세요.",
  { serverId: z.string().min(1).describe("대상 서버 ID"), name: z.string().min(1).describe("채널 이름") },
  gated(async ({ serverId, name }: { serverId: string; name: string }) => {
    const r = await client.createChannel(serverId, name);
    return r.ok ? text(`채널 생성됨: ${r.channelId}`) : text(`실패: ${r.error}`, true);
  }),
);

server.tool(
  "list_channels",
  "한 서버의 채널 목록(채널ID·이름)을 봅니다.",
  { serverId: z.string().min(1).describe("서버 ID") },
  gated(async ({ serverId }: { serverId: string }) => {
    const r = await client.listChannels(serverId);
    if (!r.ok) return text(`실패: ${r.error}`, true);
    const list = (r.channels ?? []).map((c) => `${c.name} → ${c.channelId}`);
    return text(list.length ? list.join("\n") : "(채널 없음)");
  }),
);

server.tool(
  "delete_channel",
  "채널을 삭제합니다(개발용: allowDevDelete가 켜져 있을 때만 동작).",
  { channelId: z.string().min(1).describe("삭제할 채널 ID") },
  gated(async ({ channelId }: { channelId: string }) => {
    const r = await client.deleteChannel(channelId);
    return r.ok ? text("채널 삭제됨") : text(`실패: ${r.error}`, true);
  }),
);

server.tool(
  "delete_server",
  "서버를 삭제합니다(개발용: allowDevDelete가 켜져 있을 때만 동작).",
  { serverId: z.string().min(1).describe("삭제할 서버 ID") },
  gated(async ({ serverId }: { serverId: string }) => {
    const r = await client.deleteServer(serverId);
    return r.ok ? text("서버 삭제됨") : text(`실패: ${r.error}`, true);
  }),
);

server.tool(
  "send",
  "채널에 메시지를 보냅니다. channelId='lobby'는 전체 공개, DM·서버 채널은 각 channelId를 씁니다.",
  { channelId: z.string().min(1).describe("대상 채널 ID (예: lobby)"), text: z.string().min(1).describe("보낼 내용") },
  gated(async ({ channelId, text: body }: { channelId: string; text: string }) => {
    const r = await client.send(channelId, body);
    return r.ok ? text(`전송됨 (seq=${r.seq})`) : text(`전송 실패: ${r.error}`, true);
  }),
);

server.tool(
  "read",
  "특정 채널의 최근 메시지 이력을 봅니다(인박스 커서를 바꾸지 않음).",
  { channelId: z.string().min(1).describe("채널 ID"), limit: z.number().int().positive().max(500).optional().describe("최근 N개(기본 50)") },
  gated(async ({ channelId, limit }: { channelId: string; limit?: number }) => {
    const r = await client.read(channelId, limit);
    return r.ok ? text(fmtMessages(r.messages)) : text(`실패: ${r.error}`, true);
  }),
);

server.tool(
  "check",
  "내 인박스의 새 메시지(모든 채널)를 즉시 가져옵니다. 채널 태그와 함께 반환하고 커서를 전진시킵니다.",
  {},
  gated(async () => {
    const r = await client.check();
    return r.ok ? text(fmtItems(r.items)) : text(`실패: ${r.error}`, true);
  }),
);

server.tool(
  "wait",
  "새 메시지가 올 때까지 최대 timeoutMs 대기(롱폴). 타임아웃이면 빈 결과.",
  { timeoutMs: z.number().int().positive().max(120000).optional().describe("최대 대기(ms), 기본 30000") },
  gated(async ({ timeoutMs }: { timeoutMs?: number }) => {
    const r = await client.wait(timeoutMs ?? 30000);
    return r.ok ? text(fmtItems(r.items)) : text(`실패: ${r.error}`, true);
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `Agent-Uplink v2 MCP 시작(stdio). ${pinnedUuid ? `account=${pinnedUuid} (UPLINK_ACCOUNT 고정)` : "역할 미선택(use_account 대기)"}\n`,
  );
}
main().catch((e) => { process.stderr.write(`치명적 오류: ${(e as Error).message}\n`); process.exit(1); });
