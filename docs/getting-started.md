# Getting started

## Requirements

- Windows
- Node.js 22 or later
- An MCP client such as Claude Code or Claude Desktop

## Install

The MCP server is published on npm as [`agent-uplink`](https://www.npmjs.com/package/agent-uplink); `npx` downloads and runs it. You never start the hub yourself: the first MCP server that needs it launches it in the background.

**Claude Code (CLI):**

```bash
claude mcp add --scope user agent-uplink -- npx -y agent-uplink
```

**Any MCP client (JSON configuration):**

```json
{
  "mcpServers": {
    "agent-uplink": { "command": "npx", "args": ["-y", "agent-uplink"] }
  }
}
```

Every session that should take part needs this entry; registering it once at user scope covers all your projects.

**Pin a version:** use `agent-uplink@2.1.1` instead of `agent-uplink` in the command or `args`.

**Updating:** a hub that is already running keeps running the version that started it until it exits on idle (10 minutes after the last session leaves, by default). Close your sessions or stop the hub (PID in `%ProgramData%\AgentUplink\hub.json`) to switch right away.

**Log viewer from the command line:** `npx -p agent-uplink agent-uplink-viewer`.

## Build from source

```bash
git clone https://github.com/pkj8282/Agent-Uplink.git
cd Agent-Uplink
npm install
npm run build
```

This produces `dist/mcp/index.js` (the MCP server) and `dist/hub/index.js` (the hub). Register the built server with the absolute path of your clone:

```bash
claude mcp add agent-uplink -- node "<path-to-repo>/dist/mcp/index.js"
```

```json
{
  "mcpServers": {
    "agent-uplink": {
      "command": "node",
      "args": ["<path-to-repo>/dist/mcp/index.js"]
    }
  }
}
```

## Your first two sessions

Open two sessions in the same project folder.

In the first session:

```text
use_account                                   → lists the roles in this folder (none yet)
use_account(role: "planner",
            description: "Plans features and hands off tasks")
```

In the second session:

```text
use_account                                   → shows "planner [in use]"
use_account(role: "builder",
            description: "Implements features and reports progress")
open_dm(peer: "planner")                      → returns a channel id
send(channelId: "<dm id>", text: "Inventory UI is ready for review.")
```

Back in the first session:

```text
wait                                          → receives the builder's message
```

Until a session picks a role, every tool except `use_account`, `whoami`, and `list_accounts` answers with the list of roles and asks it to choose. The MCP server also tells the model this in its instructions, so agents usually pick a role on their own once you tell them who they are.

## Next steps

- Keep a role's account across machines or configurations: [Pinning roles](roles.md#pinning-roles-in-configuration)
- Learn how messages are delivered: [Messaging](messaging.md)
- Watch the traffic: [Log viewer](viewer.md)
