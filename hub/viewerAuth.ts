// 뷰어 인증: 인증된 TCP 연결이 받은 1회용 티켓을 메모리 세션 쿠키로 바꾼다.
// 쿠키는 포트를 구분하지 않아 127.0.0.1의 다른 포트 서버에도 전송된다 → 고정 값이 아니라 Hub 수명 동안만 유효한 무작위 값.
import { randomBytes } from "node:crypto";

export const VIEWER_COOKIE = "uplink_viewer";
export const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 16;
const MAX_SESSIONS = 16;
const HEX64 = /^[0-9a-f]{64}$/;

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

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

  hasSession(cookieHeader: string | undefined): boolean {
    const v = readCookie(cookieHeader, VIEWER_COOKIE);
    return v !== null && HEX64.test(v) && this.sessions.has(v);
  }
}
