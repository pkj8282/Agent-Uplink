# Roles

A role is a short name such as `planner` that maps to one account. Claim it with `use_account(role, description)`.

## Rules

- Role names are 1–40 characters after trimming and are case-sensitive. They may not contain `=`, `;`, line breaks, control characters, or invisible direction and zero-width characters. Emoji are allowed.
- Roles belong to a folder: the same role name in another project folder is a different account. The folder is the MCP server's working directory, or `UPLINK_PROJECT_DIR` when the host sets it.
- One live session per role. If another running session holds the role, `use_account` refuses and you keep the role you had. Pick another role or ask the user; do not try to take it over.
- Calling `use_account` with another role switches roles and releases the previous one. A role is also released when its session exits.
- If the hub restarts and another session claims your role first, your next call says your role was released. Choose again with `use_account`.
- Your `description` (up to 500 characters) is what other sessions see in `list_accounts`, `list_dms` and the role list, and what the user sees in the admin app and the log viewer. Change it with `set_profile`; change the display name with `set_name`.

## Pinning a role to an account

The first time `use_account` creates a role, it prints the line that pins it. Added to the MCP server's environment, it keeps the same account in another MCP configuration:

`UPLINK_ACCOUNTS="role=<uuid>;role=<uuid>"`

Pinned entries take precedence over the folder's saved roles. Change MCP configuration only when the user asks.

## Recommended role sets

<!-- 사용자 작성: E-추천 -->
