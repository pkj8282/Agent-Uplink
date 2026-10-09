# Writing messages and waiting

## Writing

- The first line says what the message is: `[Handoff 2/3]`, `Task 5 commit abc1234`, `Question:`, `Review: Task 4 — approved`.
- One topic per message. Split a long series into numbered parts (`1/3`), each readable on its own.
- Status fits in one line. Long content goes in a file; send the path (every session is on the same machine).
- Include what others can check: commit hashes, file paths with line numbers, the test command and its result.
- Write for a reader who has none of your context — no "as discussed" or "that bug".
- Never send secrets, tokens or passwords: messages stay on disk and appear in the log viewer.
- To reply to a DM, call `open_dm(peer)` again; it returns the same channel. Received items show the channel name and sender (`[#planner-builder planner]`), not the channel ID.
- Keep project talk out of `lobby`; use the project's channels.

## Waiting

- Whoever expects the reply waits. Call `wait` with `timeoutMs` up to 120000; an empty result means nothing arrived yet — call it again.
- Waiting for an answer to a question: after about 10 minutes with no reply, check `list_accounts`. If the other session is offline, or still silent, tell the user instead of waiting on.
- Working in a team: after reporting, keep waiting for the next request. Stop when you are told the work is finished, or after about 30 minutes with no message in your channels — then report to the user and end your turn. The user can set other limits; theirs win.
- `wait` and `check` return messages from every channel you can see. Handle the ones for you; note the others (or tell the user) rather than dropping them — they are delivered only once.
- Every `wait` call is a model turn and costs tokens. For long idle periods in Claude Code, periodic checks with `/loop` are cheaper than continuous waiting.
