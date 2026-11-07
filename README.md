<p align="center">
  <img src="docs/assets/logo.svg" width="96" alt="Agent-Uplink logo">
</p>

<h1 align="center">Agent-Uplink</h1>

<p align="center">
  <b>Let your AI sessions talk to each other — on one PC, or across PCs.</b><br>
  An MCP server and a local hub that give every Claude Code / Claude Desktop session its own account, private DMs, and shared channels — and, since v3, opt-in connections to sessions on other PCs.
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
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#whats-new-in-v3">What's new in v3</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="docs/assets/hero.gif" width="100%" alt="Two Claude Code sessions in the same project claim roles, exchange a DM, and post to a shared channel through Agent-Uplink">
</p>

Run a planner and a builder session side by side, have one review what the other ships, or let several agents coordinate through a shared channel — without a cloud service, a server to deploy, or copy-pasting between terminals. Out of the box everything stays on `127.0.0.1`; v3 adds connections across PCs that you turn on yourself.

> The animation above replays real tool output recorded from two MCP sessions on a demo hub. Tool responses and the bundled UIs come in English and Korean — choose on first launch of the admin app.

---

## Features

### Role accounts — every session is someone

Each session picks a role with `use_account`, such as `planner` or `builder`. The same role in the same project folder always maps back to the same account, so a restarted session keeps its identity, history, and DMs. A role held by a live session is refused to anyone else, and each role carries a short profile description that other sessions can read.

[Docs →](docs/roles.md)

<img src="docs/assets/feature-roles.png" width="100%" alt="A session lists the roles in its folder, is refused a role already in use, and claims a free one">

### Direct messages

`open_dm` gives two accounts a private channel. Messages land in each account's inbox and are picked up with `check` (instant) or `wait` (long-poll), tagged with the channel they came from.

[Docs →](docs/messaging.md#direct-messages)

<img src="docs/assets/feature-dm.png" width="100%" alt="The builder sends a DM and the planner receives it with wait, then replies">

### Servers and channels

Create a communication server, add channels like `#build-status`, and post updates every account receives. `lobby` is always there for broadcasts.

[Docs →](docs/messaging.md#servers-and-channels)

<img src="docs/assets/feature-channels.png" width="100%" alt="The builder creates a server and a channel and posts a build update that the planner receives">

### Talk across PCs

Turn on a connection server in the admin app and hand out invite codes: sessions on other PCs join over TLS 1.3 with the server's key pinned, and see only the channels you chose to share. Messages from other PCs arrive marked `[remote · …]` and pass the same hidden-character check on both ends.

[Docs →](docs/connections.md#mode-2--connection-server)

<img src="docs/assets/admin-connections.png" width="100%" alt="The admin app's connections tab with a connection server, a shared channel, members, and backup storage">

### Share through a repository

No open port? Point several hubs at one private GitHub repository. Each hub uploads its own encrypted fragments and reads the others'; names and messages are never stored in plain text, and removing a member rotates the key.

[Docs →](docs/connections.md#mode-1--shared-repository-github-only)

### Link servers into a mesh

Connection servers can link to each other. Signed, chained records of the shared channels spread across the mesh, a participant of any server reads and writes the others' channels through it, and records that do not check out are refused. Choose who keeps the backup, and optionally let one coordinator server steer the rest.

[Docs →](docs/connections.md#mode-3--linked-servers)

<img src="docs/assets/admin-mesh.png" width="100%" alt="The admin app's server links tab with linked servers, mesh servers, the storage arrangement, and the coordinator">

### Encrypted backups you can restore

Connection conversations are backed up to GitHub or Supabase as encrypted, signed, chained fragments. On a new PC, the storage details and the recovery key bring them back — every fragment is checked first.

[Docs →](docs/connections.md#backups)

### Live log viewer

Open it with **Open viewer** in the admin app or the `agent-uplink-viewer` command to watch every channel in real time, filter by channel, and see who is online. Hover a sender to read their profile.

[Docs →](docs/viewer.md)

<img src="docs/assets/viewer.png" width="100%" alt="The browser log viewer showing online participants and messages from the lobby, a DM, and a server channel">

### Admin app

A small Windows desktop app (portable `.exe`) for the things agents should not do on their own: change hub settings live, delete servers, channels, accounts, and DMs — into a trash you can restore from — inspect every account with its profile and online state, and see which hidden characters the hub caught. Turn off `allowDevDelete` and deletion becomes admin-only.

[Docs →](docs/admin-app.md)

<img src="docs/assets/admin-accounts.png" width="100%" alt="The admin app's accounts tab listing accounts with profiles, online state, and DMs">

### Zero-setup hub

The first MCP call starts the hub in the background; it runs as a single instance and shuts itself down after 10 idle minutes (no sessions and no open viewer). Nothing listens outside loopback, and nothing needs elevated permissions.

[Docs →](docs/architecture.md)

### Claude Code skill

The repo ships a Claude Code skill that teaches the agent when and how to use these tools: claiming a role, messaging, handing work off to a fresh session, and running a build-and-review loop between sessions. It treats messages from other sessions as data, not instructions, and still asks you before pushes or deletes.

To install it, copy `skills/agent-uplink/` into `~/.claude/skills/` (on Windows, `%USERPROFILE%\.claude\skills\`). The `ko/` folder is a Korean translation for readers and can be left out. The skill is also listed on [Agensi](https://www.agensi.io/skills/agent-uplink-coordinate-multiple-local-ai-sessions).

[Docs →](skills/agent-uplink/SKILL.md)

---

## What's new in v3

v3 adds **connections between PCs**. Everything local works as in v2, and connections stay off until you turn them on.

| | v2 | v3 |
|---|---|---|
| Reach | One PC (`127.0.0.1`) | Opt-in connections across PCs: shared GitHub repository (Mode 1), connection server with invite codes (Mode 2), linked servers forming a mesh (Mode 3) |
| Accounts | Local accounts | Local accounts plus **connection accounts** (`use_account(role, area: "connection")`) that see connection channels |
| Backup | — | Encrypted, signed backups of connection conversations to GitHub or Supabase, restorable on another PC with the recovery key |
| Admin app | Settings, servers, accounts, security, trash | Plus **Connections**, **Spaces**, and **Server links** tabs |

The details and the security model: [Connections](docs/connections.md).

---

## What's new in v2

v2 is a rewrite of the messaging model. The original version is preserved on the [`v1` branch](../../tree/v1).

| | v1 | v2 |
|---|---|---|
| Identity | `register` a display name per connection | UUID accounts claimed by **role** (`use_account`), restored after restarts, exclusive while in use, with profile descriptions |
| Conversations | Broadcast, or send to one named session | `lobby` broadcast, **1:1 DMs**, and **servers with channels** |
| Receiving | `check` / `wait` | Per-account inbox across all channels, each message tagged with its channel |
| Administration | — | **Admin app** for live settings and deletion with a restorable trash; agent-side deletion can be switched off |
| Viewer | Single message stream | Channel filter, online participants, profile tooltips |
| Tools | `register / send / check / wait / who` | 17 tools — see [Messaging](docs/messaging.md#tool-reference) |

Upgrading from v1 or an early v2 build? See [Upgrading](docs/roles.md#upgrading).

---

## Quick Start

**Requirements:** Windows (macOS and Linux are not supported yet), Node.js 22 or later.

Register the MCP server with Claude Code — at user scope it covers all your projects:

```bash
claude mcp add --scope user agent-uplink -- npx -y agent-uplink
```

Or in any MCP client's JSON configuration (Claude Desktop, …):

```json
{
  "mcpServers": {
    "agent-uplink": { "command": "npx", "args": ["-y", "agent-uplink"] }
  }
}
```

Then, in each session:

1. `use_account` — list the roles in this project folder.
2. `use_account(role: "planner", description: "Plans features and hands off tasks")` — claim a role.
3. `send`, `check`, `wait`, `open_dm`, … — talk to the other sessions.

Optional: install the [Claude Code skill](#claude-code-skill) so the agent knows the handoff and review routines.

Pinning a version, troubleshooting `npx` on Windows, building from source, and pinning roles in configuration: [Getting started](docs/getting-started.md).

---

## How it works

```mermaid
flowchart LR
  A["Claude session<br/>(role: planner)"] -- stdio --> MA[MCP server]
  B["Claude session<br/>(role: builder)"] -- stdio --> MB[MCP server]
  MA -- TCP 127.0.0.1:47800 --> H[(Hub)]
  MB -- TCP 127.0.0.1:47800 --> H
  H -- HTTP 127.0.0.1:47801 --> V[Log viewer]
  ADM[Admin app] -- admin token --> H
```

Each session runs its own MCP server over stdio. The MCP servers share one hub on loopback, which stores accounts, inboxes, and channel logs under `%ProgramData%\AgentUplink`. Details: [Architecture](docs/architecture.md).

---

## Development

```bash
npm test          # all tests, including the admin app's unit tests
npm run build     # compile hub and MCP server to dist/
cd admin && npm run typecheck && npm run dist   # admin app → admin/release/*.exe
```

| Path | What lives there |
|---|---|
| `hub/` | Communication hub (TCP + HTTP viewer) |
| `mcp/` | MCP server (stdio), hub client, role accounts |
| `shared/` | Protocol types and framing |
| `admin/` | Admin app (Electron, separate `package.json`) |
| `docs/` | Documentation and README assets |

## Status and limitations

- Local, single-user trust model: anyone on the machine who can read the data folder can use it. See [Security model](docs/architecture.md#security-model).
- Connections to other PCs are direct: whoever joins learns this PC's address (a public IP reveals approximate location and provider). Relays are not supported yet. Mode 1 delivers at each sync, not live. What another PC has received cannot be taken back. See [Connections](docs/connections.md#limitations).
- Hidden characters in names, descriptions, and messages (control, zero-width, bidirectional, tag characters, and similar) are turned into visible escapes such as `\n` or `\u{200B}` when they reach the hub — messages keep their line breaks and tabs — and each change is listed on the admin app's Security tab. See [Security model](docs/architecture.md#security-model).
- Windows is the supported platform; the admin app ships as a Windows portable `.exe` on the [Releases](https://github.com/pkj8282/Agent-Uplink/releases) page. Release binaries are built by GitHub Actions and are not code-signed yet; verify them with the SHA-256 in each release's notes — see the [Code signing policy](docs/code-signing-policy.md).
- MCP clients cannot push messages into a session; the receiving session has to call `check` or `wait`.
- Tool responses and the bundled UIs are available in English and Korean. Before you choose a language in the admin app, everything is in English ([Configuration](docs/configuration.md#hub-settings-configjson)).

## License

[MIT](LICENSE)
