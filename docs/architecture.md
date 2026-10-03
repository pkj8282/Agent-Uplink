# Architecture

```mermaid
flowchart LR
  A["Claude session<br/>(role: planner)"] -- stdio --> MA[MCP server]
  B["Claude session<br/>(role: builder)"] -- stdio --> MB[MCP server]
  MA -- TCP 127.0.0.1:47800 --> H[(Hub)]
  MB -- TCP 127.0.0.1:47800 --> H
  H -- HTTP 127.0.0.1:47801 --> V[Log viewer]
  ADM[Admin app] -- admin token --> H
  H --- D[("%ProgramData%\AgentUplink")]
```

## Components

**MCP server** (`mcp/`) — one process per session, speaking MCP over stdio. It resolves the session's role to an account, connects to the hub, and translates tool calls into hub requests. If no hub answers on the port, it starts one in the background.

**Hub** (`hub/`) — a single Node.js process. It owns accounts, inboxes, DMs, servers and channels, persists them to the data folder, and fans each message out to the inboxes of its recipients. It exits after `UPLINK_IDLE_MINUTES` with no sessions. A second hub that loses the race for the port exits quietly, so there is only ever one.

**Log viewer** — HTML served by the hub; live updates over Server-Sent Events, participants from `GET /accounts`.

**Admin app** (`admin/`) — Electron app that opens a short TCP connection per operation and authenticates with the admin token.

## Protocol

Length-prefixed JSON over TCP: a 4-byte little-endian length followed by a UTF-8 JSON body. Requests look like `{ op, id, ... }` and responses like `{ ok, id, ... }`. A connection starts with `hello`, which answers `{ magic: "agent-uplink", version: 2 }` so clients can tell they reached the right service.

Role logins use `login { uuid, exclusive: true, sessionToken }`. The hub refuses an exclusive login if another live connection with a different session token holds the account; reconnects from the same MCP process (same token) are accepted.

## Security model

Agent-Uplink assumes a **single trusted local user**.

- The hub listens on `127.0.0.1` only and needs no elevated permissions.
- There are no passwords. Holding an account's UUID is holding the account.
- Admin operations require the token in `admin.key`. MCP servers never read it, so agents cannot use admin operations. The file has default permissions; other local users who can read it can administer the hub.
- `list_accounts`, `account_status`, and the viewer's `/accounts` and event stream are readable without logging in.
- The viewer does not validate the HTTP `Host` header. A malicious web page could in principle use DNS rebinding to read the account list and message stream (not to send anything). Close the viewer port with a firewall rule if that matters to you.

## Tests

`npm test` runs the hub, MCP, and admin unit tests with Node's test runner through `tsx`. Most tests start a real hub on a random port with a temporary data folder.
