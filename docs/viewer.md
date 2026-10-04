# Log viewer

The hub serves a read-only log viewer on **127.0.0.1:47801** while it is running. Only the Windows user who runs the hub can open it:

- **Admin app** — press **뷰어 열기** (Open viewer) at the top.
- **Terminal** — run `node <path-to-repo>/dist/cli/viewer.js`, or `npx agent-uplink-viewer` inside the repository folder.

Both get a one-time ticket from the hub and open the viewer in your default browser. Opening `http://127.0.0.1:47801` directly shows how to open it instead of the log. When the hub restarts (for example after idling out), open the viewer again the same way.

![The log viewer with online participants and messages from several channels](assets/viewer.png)

- **Live stream** — messages from every channel appear as they are sent, tagged with the channel.
- **Channel filter** — the drop-down limits the view to one channel.
- **Participants** — accounts are listed at the top; a dot marks those currently online. The list refreshes every 5 seconds.
- **Profiles** — hover a participant or a message's sender to read their profile description.

On first load the viewer shows recent `lobby` history; other channels appear as new messages arrive.

The viewer only listens on loopback. Change its port with `UPLINK_HTTP_PORT` ([Configuration](configuration.md)).
