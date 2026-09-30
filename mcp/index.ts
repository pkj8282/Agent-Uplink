// Agent Uplink — AI 세션 간 메시지 교환 MCP 서버(stdio).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HubClient } from "./hubClient.js";
import { Message } from "../shared/protocol.js";

const client = new HubClient({ port: Number(process.env.UPLINK_TCP_PORT ?? 47800) });

const server = new McpServer({ name: "agent-uplink", version: "0.1.0" });

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], isError };
}

function formatMessages(msgs: Message[] | undefined): string {
  if (!msgs || msgs.length === 0) return "(새 메시지 없음)";
  return msgs
    .map((m) => `[${new Date(m.ts).toLocaleTimeString()} ${m.from}→${m.to ?? "ALL"}] ${m.text}`)
    .join("\n");
}

server.tool(
  "register",
  "이 세션을 Agent-Uplink에 등록하고 이름을 정합니다. 이름을 생략하면 uplink-N이 자동 부여됩니다. 다른 툴 사용 전에 먼저 호출하는 것을 권장합니다.",
  { name: z.string().optional().describe("이 세션의 표시 이름(예: A). 중복 시 -2가 붙습니다.") },
  async ({ name }) => {
    try {
      const r = await client.register(name);
      if (!r.ok) return text(`등록 실패: ${r.error ?? "unknown"}`, true);
      return text(`등록됨. 세션 이름: ${r.name}`);
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

server.tool(
  "send",
  "다른 AI 세션들에게 메시지를 보냅니다. to를 지정하면 그 세션에게만, 생략하면 전체에게 전송됩니다(로그에는 항상 기록).",
  {
    text: z.string().min(1).describe("보낼 메시지 내용"),
    to: z.string().optional().describe("대상 세션 이름. 생략 시 전체 브로드캐스트."),
  },
  async ({ text: body, to }) => {
    try {
      const r = await client.send(body, to);
      if (!r.ok) return text(`전송 실패: ${r.error ?? "unknown"}`, true);
      return text(`전송됨 (seq=${r.seq})`);
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

server.tool(
  "check",
  "지난 확인 이후 나에게 온 새 메시지(전체 브로드캐스트 + 나를 대상으로 한 것)를 즉시 가져옵니다. 대기하지 않고 바로 반환합니다.",
  {},
  async () => {
    try {
      const r = await client.check();
      if (!r.ok) return text(`확인 실패: ${r.error ?? "unknown"}`, true);
      return text(formatMessages(r.messages));
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

server.tool(
  "wait",
  "새 메시지가 올 때까지 최대 timeoutMs 동안 기다렸다가 반환합니다(롱폴). 다른 세션의 응답을 기다릴 때 사용합니다. 타임아웃되면 빈 결과를 돌려줍니다.",
  { timeoutMs: z.number().int().positive().max(120000).optional().describe("최대 대기 시간(ms). 기본 30000, 최대 120000.") },
  async ({ timeoutMs }) => {
    try {
      const r = await client.wait(timeoutMs ?? 30000);
      if (!r.ok) return text(`대기 실패: ${r.error ?? "unknown"}`, true);
      return text(formatMessages(r.messages));
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

server.tool(
  "who",
  "현재 Agent-Uplink에 접속 중인 세션 목록을 봅니다.",
  {},
  async () => {
    try {
      const r = await client.who();
      if (!r.ok) return text(`조회 실패: ${r.error ?? "unknown"}`, true);
      const names = (r.sessions ?? []).map((s) => s.name);
      return text(names.length ? `접속 중: ${names.join(", ")}` : "(접속 세션 없음)");
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Agent-Uplink MCP 서버 시작(stdio).\n");
}

main().catch((e) => {
  process.stderr.write(`치명적 오류: ${(e as Error).message}\n`);
  process.exit(1);
});
