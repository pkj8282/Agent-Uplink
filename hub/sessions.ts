import { Message } from "../shared/protocol.js";

export interface Waiter {
  resolve: (msgs: Message[]) => void;
  timer: NodeJS.Timeout;
}

export class Session {
  name: string;
  since = Date.now();
  lastDeliveredSeq = 0;
  waiter: Waiter | null = null;
  constructor(name: string) {
    this.name = name;
  }
}

export class SessionRegistry {
  private sessions = new Set<Session>();
  private autoCounter = 0;

  create(startSeq: number): Session {
    const s = new Session(`uplink-${++this.autoCounter}`);
    s.lastDeliveredSeq = startSeq;
    this.sessions.add(s);
    return s;
  }

  rename(s: Session, name: string): string {
    let candidate = name;
    let n = 1;
    const taken = () => [...this.sessions].some((x) => x !== s && x.name === candidate);
    while (taken()) candidate = `${name}-${++n}`;
    s.name = candidate;
    return candidate;
  }

  remove(s: Session): void {
    if (s.waiter) {
      clearTimeout(s.waiter.timer);
      s.waiter = null;
    }
    this.sessions.delete(s);
  }

  list(): { name: string; since: number }[] {
    return [...this.sessions].map((s) => ({ name: s.name, since: s.since }));
  }

  all(): Session[] {
    return [...this.sessions];
  }
}
