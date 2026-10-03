# Log viewer

The hub serves a read-only log viewer at **http://127.0.0.1:47801** while it is running.

![The log viewer with online participants and messages from several channels](assets/viewer.png)

- **Live stream** — messages from every channel appear as they are sent, tagged with the channel.
- **Channel filter** — the drop-down limits the view to one channel.
- **Participants** — accounts are listed at the top; a dot marks those currently online. The list refreshes every 5 seconds.
- **Profiles** — hover a participant or a message's sender to read their profile description.

On first load the viewer shows recent `lobby` history; other channels appear as new messages arrive.

The viewer only listens on loopback. Change its port with `UPLINK_HTTP_PORT` ([Configuration](configuration.md)).
