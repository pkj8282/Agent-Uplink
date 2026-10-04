# Security policy

## Supported versions

Security fixes go into the latest release only. Please update to the newest version on the [Releases](https://github.com/pkj8282/Agent-Uplink/releases) page before reporting.

| Version | Supported |
|---|---|
| 2.0.x (latest) | ✅ |
| 1.x (`v1` branch) | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/pkj8282/Agent-Uplink/security/advisories/new)). Only the maintainer can see the report.

Please include:

- the version (or commit) and your Windows / Node.js versions,
- what an attacker can do and under which conditions (for example "a web page the user opens", "another Windows user on the same PC"),
- steps or a small script to reproduce it.

This is a project maintained by one person in their spare time. Reports are handled on a best-effort basis: you will get an acknowledgement, a fix in a new release once the problem is confirmed, and credit in the release notes and advisory unless you prefer otherwise. Please give us a reasonable chance to release a fix before disclosing details publicly.

## Scope

In scope: the hub (TCP `127.0.0.1:47800`), the log viewer (HTTP `127.0.0.1:47801`), the MCP server, the admin app, and the data they keep on disk.

Before reporting, please read the [Security model](docs/architecture.md#security-model). In short:

- Agent-Uplink is built for one local user. Programs running as **the same Windows user** can already read the data folder and are treated as trusted.
- Since v2.0.2 the hub serves only clients that prove they can read `client.key` in the data folder (a mutual HMAC challenge-response; the key itself is never sent). The data folder is restricted to the current user, SYSTEM, and Administrators, and the hub refuses to start if anything in it is owned by another user. The log viewer opens only through a one-time ticket from the admin app or `agent-uplink-viewer`.
- **Remaining limits:** another local user can still occupy the hub's ports and make it unavailable (denial of service). Messages from other sessions are untrusted text, and an agent can be talked into actions by them — tool annotations and the server's instructions warn about this, but approving risky actions stays with you and your MCP client. Reports that only restate these limits are already known.
- Release binaries are not code-signed yet; verify them with the SHA-256 in each release's notes ([Code signing policy](docs/code-signing-policy.md)).

## 한국어 요약

- 보안 문제는 **공개 이슈로 올리지 말고**, 저장소 **Security 탭 → Report a vulnerability**로 비공개 제보해 주세요.
- 수정은 최신 릴리스(2.0.x)에만 들어갑니다.
- 개인이 여가 시간에 관리하는 프로젝트라 최선을 다해 처리합니다. 확인되면 새 릴리스로 고치고, 원하시면 릴리스 노트에 제보자를 밝힙니다.
- 같은 Windows 사용자 권한의 프로그램은 신뢰 범위입니다. v2.0.2부터 같은 PC의 다른 Windows 사용자는 Hub·뷰어·데이터 폴더에 접근할 수 없습니다. 남은 한계: 다른 사용자가 포트를 점유해 서비스를 방해하는 것, 다른 세션 메시지에 의한 프롬프트 인젝션(도구 표시와 안내로 완화).
