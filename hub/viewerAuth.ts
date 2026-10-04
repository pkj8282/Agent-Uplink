// 뷰어 인증: 인증된 TCP 연결이 받은 1회용 티켓을 메모리 세션 값으로 바꾼다.
// 쿠키는 쓰지 않는다 — 쿠키는 포트를 구분하지 않아 127.0.0.1의 다른 포트 서버(다른 사용자가 띄운 것 포함)로
// 실려 갈 수 있다. 세션 값은 뷰어 페이지가 sessionStorage(포트까지 포함한 origin 단위)에 두고 ?s=로 붙인다.
import { randomBytes } from "node:crypto";

export const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 16;
const MAX_SESSIONS = 16;
const HEX64 = /^[0-9a-f]{64}$/;

export class ViewerAuth {
  private tickets = new Map<string, number>(); // ticket → 만료 시각(삽입 순 = 오래된 순)
  private sessions = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  issueTicket(): string {
    const t = this.now();
    for (const [k, exp] of this.tickets) if (exp <= t) this.tickets.delete(k);
    while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value as string);
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, t + TICKET_TTL_MS);
    return ticket;
  }

  /** 유효한 티켓이면 소진하고 새 세션 값을 준다. */
  redeem(ticket: unknown): string | null {
    if (typeof ticket !== "string" || !HEX64.test(ticket)) return null;
    const exp = this.tickets.get(ticket);
    if (exp === undefined) return null;
    this.tickets.delete(ticket);
    if (exp <= this.now()) return null;
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.values().next().value as string);
    const session = randomBytes(32).toString("hex");
    this.sessions.add(session);
    return session;
  }

  hasSession(value: unknown): boolean {
    return typeof value === "string" && HEX64.test(value) && this.sessions.has(value);
  }
}
