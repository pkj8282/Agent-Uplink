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
  clientId: string | null = null;
  owner: unknown = null; // 현재 이 세션을 소유한 연결(소켓). 재연결 시 갱신된다.
  constructor(name: string) {
    this.name = name;
  }
}

export class SessionRegistry {
  private sessions = new Set<Session>();
  private byClientId = new Map<string, Session>();
  private autoCounter = 0;

  create(startSeq: number): Session {
    const s = new Session(`uplink-${++this.autoCounter}`);
    s.lastDeliveredSeq = startSeq;
    this.sessions.add(s);
    return s;
  }

  /** clientId로 기존 세션을 찾는다(없으면 undefined). */
  byClient(clientId: string): Session | undefined {
    return this.byClientId.get(clientId);
  }

  /** 세션에 clientId를 묶는다(재연결 시 같은 세션으로 이어지기 위한 키). */
  bindClient(s: Session, clientId: string): void {
    s.clientId = clientId;
    this.byClientId.set(clientId, s);
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
    if (s.clientId && this.byClientId.get(s.clientId) === s) {
      this.byClientId.delete(s.clientId);
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
