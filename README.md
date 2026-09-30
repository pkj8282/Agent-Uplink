# Agent-Uplink

로컬 PC 안에서 여러 AI 세션(Claude Code, Claude Desktop 등)이 서로 메시지를 주고받게 하는 MCP + 커뮤니케이션 서버.

- **Hub**: `127.0.0.1:47800`(에이전트 TCP) + `127.0.0.1:47801`(브라우저 로그 뷰어). 첫 MCP가 자동으로 띄우며, 단일 인스턴스로 동작.
- **MCP(Agent Uplink)**: 각 AI 세션에 stdio로 붙어 Hub에 연결. `register / send / check / wait / who` 툴 제공.
- **로그 뷰어**: 브라우저로 `http://127.0.0.1:47801` 접속 시 메시지 흐름 실시간 확인.

> 로컬 전용입니다. 외부 네트워크에 노출되지 않으며 권한 상승도 하지 않습니다.

## 빌드

```cmd
cd C:\Research\Agent-Uplink
npm install
npm run build
```
→ `dist/mcp/index.js`, `dist/hub/index.js` 생성.

## MCP 등록 (Claude Code 예시)

각 세션의 MCP 설정에 아래를 추가합니다(세션마다 붙이면 됩니다):

```json
{
  "mcpServers": {
    "agent-uplink": {
      "command": "node",
      "args": ["C:\\Research\\Agent-Uplink\\dist\\mcp\\index.js"]
    }
  }
}
```

첫 세션이 툴을 호출하면 Hub가 자동으로 백그라운드에서 시작됩니다. 별도 설치·수동 실행은 필요 없습니다.

## 사용

1. 각 세션에서 `register`로 이름을 정합니다(예: A, B). 생략하면 `uplink-N` 자동.
2. `send`로 메시지를 보냅니다. `to`를 주면 특정 세션에게만, 생략하면 전체에게.
3. 상대 세션은 `check`(즉시 조회) 또는 `wait`(새 메시지 올 때까지 대기)로 받습니다.
4. `who`로 현재 접속 세션을 확인합니다.
5. 브라우저로 `http://127.0.0.1:47801`을 열면 전체 흐름을 눈으로 봅니다.

> **중요(수신 방식)**: MCP는 구조상 메시지를 자동으로 밀어 넣지 못합니다. 상대 세션이 `check`/`wait`를 호출하는 순간에만 수신됩니다. 협업 중 응답을 기다릴 땐 `wait`를 쓰세요.

## 환경변수(선택)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `UPLINK_TCP_PORT` | 47800 | 에이전트 TCP 포트 |
| `UPLINK_HTTP_PORT` | 47801 | 뷰어 HTTP 포트 |
| `UPLINK_DATA_DIR` | `%ProgramData%\AgentUplink` | 메시지 로그·hub.json 저장 위치 |
| `UPLINK_IDLE_MINUTES` | 10 | 모든 세션이 떠난 뒤 Hub 자동 종료까지 분. `0`이면 종료 안 함 |

> MCP와 Hub가 같은 포트를 쓰도록, 포트를 바꾸려면 두 값을 각 세션의 MCP 환경에 동일하게 설정하세요.

## 테스트

```cmd
npm test
```

## 구조

- `shared/` — 프로토콜 타입·프레이밍(공용)
- `hub/` — 커뮤니케이션 서버(TCP + HTTP 뷰어)
- `mcp/` — Agent Uplink MCP 서버(stdio) + Hub 클라이언트
