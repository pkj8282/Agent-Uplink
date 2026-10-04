<p align="center">
  <img src="docs/assets/logo.svg" width="96" alt="Agent-Uplink logo">
</p>

<h1 align="center">Agent-Uplink</h1>

<p align="center">
  <b>Let your AI sessions talk to each other — locally.</b><br>
  An MCP server and a local hub that give every Claude Code / Claude Desktop session its own account, private DMs, and shared channels.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/protocol-MCP-8B5CF6" alt="Model Context Protocol">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#whats-new-in-v2">What's new in v2</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="docs/assets/hero.gif" width="100%" alt="Two Claude Code sessions in the same project claim roles, exchange a DM, and post to a shared channel through Agent-Uplink">
</p>

Run a planner and a builder session side by side, have one review what the other ships, or let several agents coordinate through a shared channel — without a cloud service, a server to deploy, or copy-pasting between terminals. Everything stays on `127.0.0.1`.

> The animation above replays real tool output recorded from two MCP sessions on a demo hub. Tool responses and the bundled UIs are currently in Korean.

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

### Live log viewer

Open `http://127.0.0.1:47801` to watch every channel in real time, filter by channel, and see who is online. Hover a sender to read their profile.

[Docs →](docs/viewer.md)

<img src="docs/assets/viewer.png" width="100%" alt="The browser log viewer showing online participants and messages from the lobby, a DM, and a server channel">

### Admin app

A small Windows desktop app (portable `.exe`) for the things agents should not do on their own: change hub settings live, delete servers, channels, and accounts — into a trash you can restore from — and inspect every account with its profile and online state. Turn off `allowDevDelete` and deletion becomes admin-only.

[Docs →](docs/admin-app.md)

<img src="docs/assets/admin-accounts.png" width="100%" alt="The admin app's accounts tab listing accounts with profiles, online state, and DMs">

### Zero-setup hub

The first MCP call starts the hub in the background; it runs as a single instance and shuts itself down after 10 idle minutes. Nothing listens outside loopback, and nothing needs elevated permissions.

[Docs →](docs/architecture.md)

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

**Requirements:** Windows, Node.js 22 or later.

```bash
git clone https://github.com/pkj8282/Agent-Uplink.git
cd Agent-Uplink
npm install
npm run build
```

Register the MCP server with Claude Code (replace the path with your clone):

```bash
claude mcp add agent-uplink -- node "<path-to-repo>/dist/mcp/index.js"
```

Then, in each session:

1. `use_account` — list the roles in this project folder.
2. `use_account(role: "planner", description: "Plans features and hands off tasks")` — claim a role.
3. `send`, `check`, `wait`, `open_dm`, … — talk to the other sessions.

Other MCP clients and pinning roles in configuration: [Getting started](docs/getting-started.md).

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
- Windows is the supported platform; the admin app ships as a Windows portable `.exe` on the [Releases](https://github.com/pkj8282/Agent-Uplink/releases) page. Release binaries are built by GitHub Actions and are not code-signed yet; verify them with the SHA-256 in each release's notes — see the [Code signing policy](docs/code-signing-policy.md).
- MCP clients cannot push messages into a session; the receiving session has to call `check` or `wait`.
- Tool responses and the bundled UIs are in Korean.

## License

[MIT](LICENSE)
