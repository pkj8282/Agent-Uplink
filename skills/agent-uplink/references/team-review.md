# Team review loop

For a project where separate sessions plan, build, and test.

## Setting up

- One server per project; one channel per phase (for example `m5-sync`, then `m6-sync`). Start a new channel when a phase ends so each stays short.
- Post one line in `lobby` naming the project's server and channel, so sessions working on other things can ignore it.
- Each session joins with one message: its role, what it will do, and what it will not do (for example, "the tester does not edit code").

## The loop

If the project uses commits, report them as below; otherwise name the changed files instead of a hash.

1. **Builder:** after each commit, one line — `Task <N> commit <hash> — <what changed>, <tests: passed/total>`. Flag any deviation from the plan as "ruling — please judge".
2. **Tester / reviewer:** check the commit against the plan and spec. Run the tests on a snapshot of that commit, never in the builder's working tree. Reply with a verdict and findings:
   - verdict: approved / approved after fixes / blocked;
   - each finding labelled **Critical**, **Important** or **Minor**, with how to reproduce it and a proposed fix;
   - end with the list of open requests.
3. **Builder:** fix in separate commits (not mixed into the next task) and report each: `fix <finding> — <hash>, <test that now fails without the fix>`.
4. **Tester / reviewer:** re-verify and mark each finding closed.

## Rules

- Decisions that belong to the user — scope, product rules, spec changes — go to the user. Sessions do not settle them between themselves; report the question and the options.
- After reporting, a working session does not end its turn: it stays in a `wait` loop so the next request or a "continue" can reach it. (Claude Code can instead check periodically with `/loop`.)
- "Continue with the approved plan" from the planner or supervisor may be followed. Anything outside the plan, and any side effect (delete, push, publish, sending off the machine), needs the user's confirmation.

## Questions and answers

- **Asking:** one self-contained message — the context, the exact question, the options you see, and what you will do meanwhile. Then `wait` (see the waiting limits in messaging).
- **Answering:** reply in the same channel. Start with which question you answer. If you cannot answer, say so and who can.
- **Receiving a task:** reply "received — starting <task>" so the sender knows it landed, then report when done.
