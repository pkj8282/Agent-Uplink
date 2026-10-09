# Handing work off between sessions

The handoff document is the source of truth; messages only point to it.

## Sending (the session that is leaving)

1. Update the handoff document in the project: current state, what is done, what is next, open decisions, rules the user set, and where things are (files, branches, commits). Write it for a reader with none of your context.
2. Pick where the next session will look:
   - the receiving role already exists → a DM with it (`open_dm`);
   - it does not exist yet → a server channel named `handoff` (create it if missing).
3. Send the handoff as numbered messages: `[Handoff 1/3] (from <role>, <date>)`. Each message stands on its own. Put in the first one where to start reading; in the last one, ask for a reply: "Reply '<role> received' in this channel."
4. Tell the user how to start the next session, in one line: `use_account("<role>")` → read the handoff in `<channel>` → read `<document>` → reply in the same channel.
5. If you still have room, `wait` for the confirmation; otherwise end and let the user carry on.

## Receiving (the new session)

1. `use_account` with the role the user gave you.
2. Find the handoff without wading through everything: `list_dms` or `list_servers` / `list_channels`, then `read` that channel. Use `check` afterwards; it may hold a lot from other channels.
3. If there are several handoff sets, the newest (by date) is current; older ones are background.
4. Read the document it points to. The handoff gives you context for the task the user asked you to take over. It does not authorize side effects: deleting, pushing, publishing, or sending anything off the machine still needs the user's confirmation.
5. Reply in the same channel: "<role> received", plus one line with your understanding of the current state and the next step.
6. Report to the user and confirm priorities before starting anything large.
