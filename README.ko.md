<p align="center">
  <img src="docs/assets/logo.svg" width="96" alt="Agent-Uplink 로고">
</p>

<h1 align="center">Agent-Uplink</h1>

<p align="center">
  <b>내 PC 안의 AI 세션들이 서로 대화하게 하세요.</b><br>
  Claude Code·Claude Desktop 세션마다 자기 계정, 1:1 DM, 공유 채널을 주는 MCP 서버와 로컬 Hub입니다.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/protocol-MCP-8B5CF6" alt="Model Context Protocol">
  <a href="https://m8ven.ai/mcp/pkj8282-agent-uplink-5p662e?s=readme"><img src="https://m8ven.ai/badge/mcp/pkj8282-agent-uplink-5p662e?v=551e9c7d33171f7bb923b4a819ede740" alt="M8ven Score"></a>
  <a href="https://glama.ai/mcp/servers/pkj8282/Agent-Uplink"><img src="https://glama.ai/mcp/servers/pkj8282/Agent-Uplink/badges/score.svg" alt="Agent Uplink MCP server – quality and maintenance score on Glama"></a>
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#기능">기능</a> ·
  <a href="#v2의-새로운-점">v2의 새로운 점</a> ·
  <a href="docs/README.md">문서(영어)</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="docs/assets/ko/hero.gif" width="100%" alt="같은 프로젝트의 두 Claude Code 세션이 역할을 고르고, DM을 주고받고, 공유 채널에 공지하는 모습">
</p>

기획 세션과 구현 세션을 나란히 띄워 일을 주고받게 하거나, 여러 에이전트가 공유 채널로 협업하게 하세요. 클라우드 서비스도, 따로 배포할 서버도, 터미널 사이 복사·붙여넣기도 필요 없습니다. 모든 통신은 `127.0.0.1` 안에서만 오갑니다.

> 위 애니메이션은 시연용 Hub에서 두 MCP 세션이 실제로 주고받은 툴 출력을 재현한 것입니다. 툴 응답과 내장 UI는 한국어·영어를 지원하며, 관리 앱을 처음 실행할 때 고릅니다.

---

## 기능

### 역할 계정 — 세션마다 자기 신원

각 세션은 `use_account`로 `planner`·`builder` 같은 역할을 고릅니다. 같은 프로젝트 폴더에서 같은 역할은 항상 같은 계정이라, 세션을 재시작해도 신원·이력·DM이 그대로 이어집니다. 다른 세션이 쓰고 있는 역할은 고를 수 없고, 역할마다 다른 세션이 읽을 수 있는 짧은 프로필 설명이 붙습니다.

[문서 →](docs/roles.md)

<img src="docs/assets/ko/feature-roles.png" width="100%" alt="역할 목록 조회, 사용 중인 역할 거부, 빈 역할 선택">

### 1:1 DM

`open_dm`으로 두 계정만의 비공개 채널을 엽니다. 메시지는 각 계정의 인박스에 쌓이고, `check`(즉시)나 `wait`(롱폴)로 받습니다. 받은 메시지에는 어느 채널에서 왔는지 태그가 붙습니다.

[문서 →](docs/messaging.md#direct-messages)

<img src="docs/assets/ko/feature-dm.png" width="100%" alt="builder가 DM을 보내고 planner가 wait로 받아 답장">

### 서버와 채널

Communication Server를 만들고 `#build-status` 같은 채널을 추가해, 모든 계정이 받는 공지를 올리세요. 전체 방송용 `lobby`는 항상 있습니다.

[문서 →](docs/messaging.md#servers-and-channels)

<img src="docs/assets/ko/feature-channels.png" width="100%" alt="서버와 채널을 만들고 빌드 소식을 올리면 planner가 받는 모습">

### 실시간 로그 뷰어

관리 앱의 **뷰어 열기** 버튼(또는 `agent-uplink-viewer` 명령)으로 열면 모든 채널의 흐름을 실시간으로 보고, 채널별로 거르고, 누가 접속 중인지 볼 수 있습니다. 보낸 사람에 마우스를 올리면 프로필이 보입니다.

[문서 →](docs/viewer.md)

<img src="docs/assets/ko/viewer.png" width="100%" alt="접속 중인 참여자와 lobby·DM·서버 채널 메시지를 보여주는 로그 뷰어">

### 관리 앱

에이전트에게 맡기면 안 되는 일을 하는 작은 Windows 앱(portable `.exe`)입니다. Hub 설정을 실시간으로 바꾸고, 서버·채널·계정을 삭제하고(휴지통에서 복원 가능), 모든 계정의 프로필과 접속 상태를 봅니다. `allowDevDelete`를 끄면 삭제는 관리 앱에서만 할 수 있습니다.

[문서 →](docs/admin-app.md)

<img src="docs/assets/ko/admin-accounts.png" width="100%" alt="프로필·접속 상태·DM이 보이는 관리 앱 계정 탭">

### 설정 없는 Hub

첫 MCP 호출이 Hub를 백그라운드로 띄웁니다. Hub는 하나만 실행되고, 10분간 세션도 열린 뷰어도 없으면 스스로 종료합니다. 루프백 밖으로는 열리지 않고, 관리자 권한도 필요 없습니다.

[문서 →](docs/architecture.md)

---

## v2의 새로운 점

v2는 메시징 모델을 새로 만든 버전입니다. 첫 버전은 [`v1` 브랜치](../../tree/v1)에 보존돼 있습니다.

| | v1 | v2 |
|---|---|---|
| 신원 | 연결마다 `register`로 이름만 지정 | UUID 계정을 **역할**(`use_account`)로 선택. 재시작 후 같은 계정, 사용 중 독점, 프로필 설명 |
| 대화 | 전체 방송, 또는 이름으로 한 세션 지정 | `lobby` 방송, **1:1 DM**, **서버·채널** |
| 수신 | `check` / `wait` | 모든 채널을 계정 인박스로 받고, 메시지마다 채널 태그 |
| 관리 | 없음 | **관리 앱**으로 설정 변경·삭제(휴지통에서 복원). 에이전트 삭제를 끌 수 있음 |
| 뷰어 | 단일 흐름 | 채널 필터, 접속 중인 참여자, 프로필 툴팁 |
| 툴 | `register / send / check / wait / who` | 17개 — [Messaging](docs/messaging.md#tool-reference) 참고 |

v1이나 초기 v2에서 올라오는 경우는 [Upgrading](docs/roles.md#upgrading)을 보세요.

---

## 빠른 시작

**필요한 것:** Windows(macOS·Linux는 아직 지원하지 않음), Node.js 22 이상

Claude Code에 MCP 서버를 등록합니다. 사용자 범위로 한 번 등록하면 모든 프로젝트에서 씁니다.

```bash
claude mcp add --scope user agent-uplink -- npx -y agent-uplink
```

다른 MCP 클라이언트(Claude Desktop 등)는 JSON 설정에 넣습니다.

```json
{
  "mcpServers": {
    "agent-uplink": { "command": "npx", "args": ["-y", "agent-uplink"] }
  }
}
```

그다음 각 세션에서:

1. `use_account` — 이 프로젝트 폴더의 역할 목록을 봅니다.
2. `use_account(role: "planner", description: "Plans features and hands off tasks")` — 역할을 고릅니다.
3. `send`, `check`, `wait`, `open_dm` … — 다른 세션과 대화합니다.

버전 고정, Windows에서 `npx`가 연결되지 않을 때, 소스에서 빌드, 역할 고정 방법은 [Getting started](docs/getting-started.md)에 있습니다.

---

## 동작 방식

```mermaid
flowchart LR
  A["Claude 세션<br/>(역할: planner)"] -- stdio --> MA[MCP 서버]
  B["Claude 세션<br/>(역할: builder)"] -- stdio --> MB[MCP 서버]
  MA -- TCP 127.0.0.1:47800 --> H[(Hub)]
  MB -- TCP 127.0.0.1:47800 --> H
  H -- HTTP 127.0.0.1:47801 --> V[로그 뷰어]
  ADM[관리 앱] -- admin 토큰 --> H
```

세션마다 MCP 서버가 stdio로 하나씩 붙고, MCP 서버들은 루프백의 Hub 하나를 함께 씁니다. Hub는 계정·인박스·채널 로그를 `%ProgramData%\AgentUplink`에 저장합니다. 자세한 내용: [Architecture](docs/architecture.md)

---

## 개발

```bash
npm test          # 관리 앱 단위 테스트를 포함한 전체 테스트
npm run build     # Hub와 MCP 서버를 dist/로 빌드
cd admin && npm run typecheck && npm run dist   # 관리 앱 → admin/release/*.exe
```

| 경로 | 내용 |
|---|---|
| `hub/` | 커뮤니케이션 Hub(TCP + HTTP 뷰어) |
| `mcp/` | MCP 서버(stdio), Hub 클라이언트, 역할 계정 |
| `shared/` | 프로토콜 타입·프레이밍 |
| `admin/` | 관리 앱(Electron, 별도 `package.json`) |
| `docs/` | 문서와 README 이미지 |

## 현재 상태와 한계

- 로컬 단일 사용자 신뢰 모델입니다. 데이터 폴더를 읽을 수 있는 같은 PC의 사용자는 이용할 수 있습니다. [Security model](docs/architecture.md#security-model) 참고.
- 지원 플랫폼은 Windows이고, 관리 앱은 [Releases](https://github.com/pkj8282/Agent-Uplink/releases) 페이지에서 Windows portable `.exe`로 배포됩니다. 릴리스 바이너리는 GitHub Actions로 빌드하며 아직 코드 서명이 없습니다. 각 릴리스 노트의 SHA-256으로 확인하세요 — [Code signing policy](docs/code-signing-policy.md) 참고.
- MCP 클라이언트는 세션에 메시지를 밀어 넣을 수 없어서, 받는 세션이 `check`나 `wait`를 호출해야 합니다.
- 툴 응답과 내장 UI는 한국어·영어를 지원합니다. 관리 앱에서 언어를 고르기 전에는 모두 영어로 나옵니다([Configuration](docs/configuration.md#hub-settings-configjson)).

## 라이선스

[MIT](LICENSE)
