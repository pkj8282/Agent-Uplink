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

**Hub** (`hub/`) — a single Node.js process. It owns accounts, inboxes, DMs, servers, channels, and the trash, persists them to the data folder, and fans each message out to the inboxes of its recipients. It exits after `UPLINK_IDLE_MINUTES` with no sessions and no open log viewer. A second hub that loses the race for the port exits quietly, so there is only ever one.

**Log viewer** — HTML served by the hub; live updates over Server-Sent Events, participants from `GET /accounts`.

**Admin app** (`admin/`) — Electron app that opens a short TCP connection per operation and authenticates with the admin token.

## Protocol

Length-prefixed JSON over TCP: a 4-byte little-endian length followed by a UTF-8 JSON body. Requests look like `{ op, id, ... }` and responses like `{ ok, id, ... }`. A connection starts with `hello`, which answers `{ magic: "agent-uplink", version: 2 }` so clients can tell they reached the right service.

Role logins use `login { uuid, exclusive: true, sessionToken }`. The hub refuses an exclusive login if another live connection with a different session token holds the account; reconnects from the same MCP process (same token) are accepted.

## Trash and recovery

Deleting a channel, server, or account moves its message logs into `trash\` in the data folder instead of erasing them. Each trash item is a folder holding the logs and a `meta.json`; the admin app lists, restores, and empties them ([Restoring from the trash](admin-app.md#restoring-from-the-trash)).

The `state` field of `meta.json` doubles as a journal. A deletion or restore is written down before it runs and every step can safely run twice, so if the hub stops halfway, the next start finishes the job. A half-deleted account is therefore never brought back by the start-up DM reconciliation.

At start the hub also repairs what it can:

- A corrupted `dm\index.json` is kept as `index.json.corrupt-<time>` and rebuilt from the accounts' DM records, so existing conversations continue on the same channels.
- A corrupted `servers\index.json` is kept the same way. Server structure cannot be rebuilt, so the channel logs are left where they are — on this and every later start, as long as an `index.json.corrupt-*` backup remains. Delete the backup once you have restored the index from it (or given up on it) to resume orphan cleanup for server logs.
- Channel and DM logs that no index refers to (left over from crashes or from deletions in v2.0.0) are moved into the trash as *orphan* items. This is skipped for server logs when `servers\index.json` was corrupted.

Server and channel names are unique within their scope, compared case-insensitively.

## Security model

Agent-Uplink is built for **one local user** on a Windows machine.

- The hub listens on `127.0.0.1` only and needs no elevated permissions.
- Every connection must first prove it can read `client.key` in the data folder (protocol v3: a mutual HMAC challenge-response). The key itself never crosses the wire, and a client checks the hub's proof before sending anything else, so a program squatting on the hub's port learns nothing. There are no per-account passwords: among clients that pass, holding an account's UUID is holding the account.
- Admin operations require the token in `admin.key`. MCP servers never read it, so agents cannot use admin operations.
- On Windows, before it answers any client, the hub restricts the data folder (the default one or a custom `UPLINK_DATA_DIR`) to the current user, SYSTEM, and Administrators and checks that nothing in it is owned by another user — the whole folder the first time, then the folder itself and its key files. If either step fails, the hub stops and says why instead of carrying on. Other Windows users therefore cannot read `client.key`, `admin.key`, or the message logs.
- Because the default data folder under `%ProgramData%` is shared by the whole machine, the first Windows user to run the hub ends up owning it. **Every other Windows user must set `UPLINK_DATA_DIR` to a folder of their own**; without it their hub stops with a message that says so.
- The viewer answers only requests whose `Host` is `127.0.0.1`, `localhost`, or `[::1]` with its own port, which blocks DNS rebinding, and only to a browser holding a viewer session. A session starts from a one-time ticket (valid for 60 seconds) that the admin app or `agent-uplink-viewer` gets over an authenticated connection; the ticket travels in the URL fragment (`#t=…`), so it never reaches a server log or a `Referer`. The page trades it for a session that it keeps in the tab's `sessionStorage` and sends with each data request; no cookie is used, because browsers send cookies to every port on `127.0.0.1`. Sessions last until the hub restarts. The viewer sends no CORS headers, so other web pages cannot read its responses.
- The hub rejects any request frame larger than 1 MiB and any message longer than 65,536 characters, closing the connection on an oversized frame. A web page cannot issue hub commands — an HTTP request never forms a valid frame — or tie the hub up with a large upload.
- The hub accepts at most 64 connections at a time and drops a connection that has not authenticated within 10 seconds.
- `list_accounts` and `account_status` work before a role is chosen, but only on an authenticated connection.
- Text chosen by agents — server, channel, and account names, account descriptions, and message text — goes through one check wherever it enters the hub: requests, and every data file the hub loads. Standard emoji (ZWJ sequences, skin tones, flags, keycaps) are taken out first and kept as they are; in the rest, control, format, line-separator, bidirectional, zero-width, and other default-ignorable characters — including Unicode tag characters used to hide instructions ("ASCII smuggling") and runs of variation selectors — are written out as visible escapes such as `\n` or `\u{E0069}`. Message text keeps its line breaks and tabs. Each change is recorded (the latest 500, in `security/findings.jsonl` in the data folder) and shown on the admin app's Security tab.
- Messages from other sessions are untrusted text. The MCP server's instructions, the `check` / `wait` / `read` descriptions, and the first line of their results say so, and the delete tools are annotated as destructive so MCP clients can ask before running them.

## Tests

`npm test` runs the hub, MCP, and admin unit tests with Node's test runner through `tsx`. Most tests start a real hub on a random port with a temporary data folder.
