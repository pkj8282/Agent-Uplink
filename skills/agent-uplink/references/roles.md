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

The roles:

- `planner` — writes the plan and revises it with the user. If the user already has a plan, the planner refines it.
- `builder` — implements the plan.
- `tester` — tests the work.
- `supervisor` — watches the other sessions and their subagents, and keeps them working when they stop so the user does not have to prompt each one. Anything that needs the user's input still goes to the user.

Propose roles only when the user wants to work with several sessions. If one session looks enough for the task, say so first; propose a set only if the user still wants one.

A recommended set is a proposal, never a decision. Propose it to the user and use it only if they agree. If they suggest something else, set up the roles they ask for.

### Choosing a set

Only once the user wants several sessions:

1. **A project already under way:** if the user has already set roles, use them. If the work scores heavy (step 2) and their set has no `tester` or no `supervisor`, mention that once and leave the decision to the user. If no roles are set, ask the user to describe the project (unless they already have), then score it as in step 2.
2. **A new project, work at an early stage, or a project sent here from step 1:** score how light the work is, from 0 to 10.
   - **Loss (0 or 5).** 5 if an accident during the work would be quick to recover from; 0 if recovery would take long.
     - 0 — changing something already published or released (a package release, a public post, a public README); deleting or migrating data without a backup; security, authentication or payments; structural changes across several systems; resources other people use (pushing to a main branch others work on, shared settings).
     - 5 — local code changes that version control can undo, including a main branch only you use; documentation or wording that is not yet public; experiments on a branch; adding tests; new files that change no existing behaviour.
   - **Size (0 to 5)** — score both, then take the higher:
     - Plan steps: fewer than 3 → 5; fewer than 5 → 4; fewer than 8 → 3; fewer than 10 → 1; 10 or more → 0. With no clear plan yet, this is 0 and difficulty decides.
     - Difficulty: very simple (fix a typo or one line of text) → 5; simple (add one setting, fix a small bug in one function) → 3; balanced (add one feature to an existing screen: a few files plus tests) → 2; complex (a new module, integrating several parts, changing data structures) → 0; very complex (a new subsystem; security, payments, data migration) → 0.
   - **Total = loss + size.**
3. Read the total:
   - **7 to 10 — light:** propose `planner`, `builder`, `tester`.
   - **4 to 6 — uncertain:** show the user the score and ask whether the work is light or heavy. If they do not know, or leave it to you, treat it as heavy.
   - **0 to 3 — heavy:** propose `planner`, `builder`, `tester`, `supervisor`.
4. **A supervisor for light work:** there is none by default. Unless the user has already said, ask in the proposal, as its own question: "Do you want a supervisor session as well?" If they do, the `tester` also supervises by default.
5. When you propose, show the score and the reason for each part, including both size scores.

### Combining roles

Roles can be combined when the user wants fewer sessions, or when one role takes on another by default. Always state what is lost:

- `planner` + `builder` — nobody checks the plan independently.
- `builder` + `tester` — the same session tests its own work and misses its own blind spots.
- `tester` + `supervisor` — while testing, watching the other sessions slips.

### After the user agrees

You — the session that made the proposal — take the `planner` role with `use_account("planner", description)`. As planner, write the plan to a file and create the project's server and channel. When the user has approved the plan, give the go with `send` in that channel. The user opens the other sessions; you cannot start them. Give the user one start line for each other role:

- `New session in <folder>: use_account("builder") — you are the builder; read <plan file> and wait in <channel> for the planner's go.`
- `New session in <folder>: use_account("tester") — you are the tester; read <plan file> and wait in <channel> for the builder's report, then test it.`
- `New session in <folder>: use_account("supervisor") — you are the supervisor; watch <channel> and the other sessions, keep them working when they stop, and bring anything that needs the user to the user.`

Fill in the folder, the plan file and the channel you created. When the `tester` also supervises, say so in its start line.
