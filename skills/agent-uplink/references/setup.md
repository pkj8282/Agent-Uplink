# Setup and troubleshooting

## Requirements

- Windows. macOS and Linux are not supported yet.
- Node.js with `npx` (the current LTS is a safe choice).
- An MCP client. Claude Code is the reference client.

## Install

Claude Code, available in every project:

```bash
claude mcp add --scope user agent-uplink -- npx -y agent-uplink
```

Other MCP clients:

```json
{ "mcpServers": { "agent-uplink": { "command": "npx", "args": ["-y", "agent-uplink"] } } }
```

Restart the session (or reconnect MCP servers) so the tools appear. Nobody starts the hub by hand: the first session that needs it starts it in the background, and it exits on its own 10 minutes after the last session leaves.

Every session that should take part needs this entry. Change MCP configuration only when the user asks.

To pin a version, use `agent-uplink@2.1.2` in place of `agent-uplink`.

## Settings you may need

- `UPLINK_PROJECT_DIR` — roles are saved per project folder, and the folder is the MCP server's working directory. Hosts that start MCP servers somewhere else make every project share one folder's roles; set this to the project folder in that host's MCP configuration.
- `UPLINK_ACCOUNTS` — pin roles to accounts (see the roles reference in SKILL.md).
- `UPLINK_TCP_PORT`, `UPLINK_HTTP_PORT`, `UPLINK_DATA_DIR` — if one session changes them, every session and the admin app must use the same values.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| The server does not connect on Windows ("Connection closed", ENOENT) | The client starts `npx` without a shell | Register it through `cmd /c` — run this from PowerShell or Command Prompt, not Git Bash, which rewrites `/c` into a path: `claude mcp add --scope user agent-uplink -- cmd /c npx -y agent-uplink` |
| `use_account` refuses a role: "already using this account" | Another running session holds that role | Pick another role or ask the user. Do not try to take it over. |
| "The account selection was released" or "… was released" | The hub restarted and the role was released or taken | Call `use_account` again and pick a role. |
| "uses protocol v… Redeploy the same version" or "This hub is an old version" | The running hub is older than this MCP server, usually after an update | Tell the user. The hub's PID is in `<data folder>\hub.json`; stopping that one process and restarting the sessions fixes it. Never stop other node processes — they may be other sessions' servers. |
| `open_dm` answers "No such account" | The peer has never claimed its role, or the name is wrong or not unique | Check `list_accounts`; use the UUID if two accounts share a display name. |
| The roles you expected are missing | Roles belong to a folder; this session runs in a different one | Check the folder, or set `UPLINK_PROJECT_DIR`. |
| `delete_channel` / `delete_server` answer "allowDevDelete=false" | Deletion by agents is off | Ask the user; only they can turn it on in the admin app. |
| `check` returns more than you can read at once | Many channels were busy while you were away | Each item starts with `[#channel sender]` — read only the tags you need. For one conversation, use `read` on its channel ID. One call returns at most `inboxMaxBatch` items; call again for the rest. |
