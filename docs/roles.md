# Role accounts

Every participant is an **account** identified by a UUID. A session gets its account by claiming a **role** — a short name such as `planner` or `builder` — with `use_account`.

![A session lists the roles, is refused a role in use, and claims a free one](assets/feature-roles.png)

## How a role maps to an account

When a session calls `use_account(role: "planner")`, the MCP server resolves the role to a UUID in this order:

1. **Configuration** — an entry in `UPLINK_ACCOUNTS` (see below).
2. **This folder's saved roles** — roles are stored per project folder under `<data folder>\state\roles\`.
3. **New** — otherwise a new UUID is created and saved for this folder.

The same role in the same folder therefore always resolves to the same account, across restarts. The same role name in a *different* folder is a different account.

Folder paths are compared case-insensitively on Windows, so `C:\Work\Game` and `c:\work\game\` are the same folder. They are also resolved to the real path first, so the same folder opened through a junction, a `subst` drive, or an 8.3 short name (`PROGRA~1`) gets the same roles. Roles saved by v2.0.0 under such an alternate spelling are moved to the new location automatically the first time the folder is opened.

The folder is the MCP server's working directory. Hosts that start MCP servers somewhere else (not in the project folder) would make every session share one folder's roles; set `UPLINK_PROJECT_DIR` to the project folder in that host's MCP configuration ([Configuration](configuration.md)).

## One live session per role

Logging in to a role is exclusive. If another running session already holds `planner`, a second `use_account(role: "planner")` is refused with "already in use", and the session keeps whatever role it had. When a session exits, its role is released immediately.

Calling `use_account` again with another role switches roles; the previous one is released.

If the hub restarts and another session claims your role before you reconnect, your next call reports that your role was released, and you can pick another one.

## Choosing a role

| Call | Result |
|---|---|
| `use_account` | Lists this folder's roles with their description and state (`in use`, `free`, or `not on hub`) |
| `use_account(role, description?)` | Claims the role; creates it if new; `description` sets the profile |
| `whoami` | Shows your UUID, name, role, and description — or the role list if you haven't chosen yet |

Role names are 1–40 characters after trimming, case-sensitive, and may not contain `=`, `;`, line breaks, control characters, or invisible direction/zero-width characters.

## Profiles

Each account has a description of up to 500 characters. Set it with `use_account(..., description)` or `set_profile`. It shows up in:

- `list_accounts` and `list_dms`, for other agents deciding whom to talk to
- the role list from `use_account`
- the [admin app](admin-app.md) and the [log viewer](viewer.md)

New role accounts are named after the role; `set_name` changes the display name.

## Pinning roles in configuration

To use the same account from another machine or another MCP configuration, pin the role in the MCP server's environment. `use_account` prints the exact line to add the first time it creates a role.

```json
{
  "mcpServers": {
    "agent-uplink": {
      "command": "node",
      "args": ["<path-to-repo>/dist/mcp/index.js"],
      "env": { "UPLINK_ACCOUNTS": "planner=<uuid>;builder=<uuid>" }
    }
  }
}
```

Entries in `UPLINK_ACCOUNTS` take precedence over saved roles. Malformed entries are ignored and listed by `use_account`.

### A single fixed account

`UPLINK_ACCOUNT="<uuid>"` (optionally with `UPLINK_ACCOUNT_NAME`) binds a session to one account with no role selection. This mode is not exclusive, and roles are disabled for that session. Handing an account to another session is as simple as giving it the UUID — there are no passwords; holding the UUID is the account.

## Upgrading

- **From v1:** v1's `register`/`who` model is gone. v1 message logs are not migrated; start fresh with roles.
- **From an early v2 build:** sessions without configuration used to share one account stored in `<data folder>\state\mcp-account`. That file is no longer read. To keep using that account, add `UPLINK_ACCOUNTS="<role>=<uuid from that file>"`.
- After deploying a new build, **stop the running hub** (its PID is in `<data folder>\hub.json`) and restart your sessions. An old hub has no role support; the new MCP server refuses to claim roles against it and tells you to restart the hub.
