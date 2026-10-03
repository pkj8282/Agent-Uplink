// 계정 선택 상태와 역할 흐름(use_account). MCP 툴 배선과 분리해 Hub를 상대로 테스트한다.
import { HubClient } from "./hubClient.js";
import { RoleStore, validateRoleName } from "./roles.js";
import { AccountStatus } from "../shared/protocol.js";

export interface Selection {
  uuid: string;
  role: string | null; // null = UPLINK_ACCOUNT 고정
}

export class AccountSession {
  private sel: Selection | null;
  /** 선택이 외부 요인(역할을 다른 세션이 가져감)으로 해제됐을 때 다음 안내에 한 번 붙일 문구. */
  private lostNotice: string | null = null;

  constructor(private readonly client: HubClient, private readonly roles: RoleStore | null, pinnedUuid?: string) {
    this.sel = pinnedUuid ? { uuid: pinnedUuid, role: null } : null;
    client.onAccountLost = (reason) => {
      const role = this.sel?.role;
      this.sel = null;
      this.lostNotice = `역할 '${role ?? "?"}' 선택이 해제되었습니다(${reason}).`;
    };
  }

  get selection(): Selection | null { return this.sel; }
  get pinned(): boolean { return this.roles === null; }

  /** 계정이 필요한 툴의 관문. 선택 전이면 안내 문구, 선택됐으면 null. */
  async guard(): Promise<string | null> {
    if (this.sel) return null;
    const notice = this.lostNotice ? `${this.lostNotice}\n` : "";
    this.lostNotice = null;
    return `${notice}먼저 계정을 선택하세요: use_account(role) — 처음이면 description으로 역할 설명을 남기세요.\n\n${await this.listText()}`;
  }

  /** 이 폴더의 역할 목록(설명·사용 상태 포함). */
  async listText(): Promise<string> {
    if (!this.roles) return "(UPLINK_ACCOUNT로 고정된 세션입니다 — 역할 기능을 쓰지 않습니다.)";
    const entries = this.roles.list();
    const statuses = new Map<string, AccountStatus>();
    if (entries.length > 0) {
      const r = await this.client.accountStatus(entries.map((e) => e.uuid));
      if (!r.ok) {
        return r.error === "알 수 없는 op"
          ? "이 Hub는 역할 기능을 지원하지 않는 구버전입니다. Hub 재배포가 필요합니다."
          : `역할 상태 조회 실패: ${r.error}`;
      }
      for (const st of r.statuses ?? []) statuses.set(st.uuid, st);
    }
    const lines = entries.map((e) => {
      const st = statuses.get(e.uuid);
      const state = !st?.exists ? "Hub에 없음" : st.online ? "사용 중" : "비어 있음";
      const pinned = e.source === "env" ? " (env 고정)" : "";
      const desc = st?.description ? ` — ${st.description}` : "";
      const mine = this.sel?.uuid === e.uuid ? " ← 현재 세션" : "";
      return `- ${e.role} [${state}]${pinned}${desc}${mine}`;
    });
    const body = lines.length > 0 ? lines.join("\n") : "(아직 역할이 없습니다. use_account(role, description)으로 새 역할을 만드세요.)";
    const ignored = this.roles.ignoredEnv();
    const tail = ignored.length > 0 ? `\n무시된 UPLINK_ACCOUNTS 항목: ${ignored.join(", ")}` : "";
    return `이 폴더의 역할 (${this.roles.folder}):\n${body}${tail}`;
  }

  /** 역할을 선택(필요하면 생성)하고 독점 로그인한다. 실패 시 기존 선택을 유지한다. */
  async use(roleRaw: string, description?: string): Promise<{ ok: boolean; text: string }> {
    if (!this.roles) return { ok: false, text: "UPLINK_ACCOUNT로 고정된 세션은 역할을 바꿀 수 없습니다." };
    const v = validateRoleName(roleRaw);
    if (!v.ok) return { ok: false, text: v.error };
    const res = this.roles.resolve(v.role);
    const r = await this.client.selectAccount(res.uuid, v.role);
    if (!r.ok) return { ok: false, text: `${r.error}\n\n${await this.listText()}` };
    this.sel = { uuid: res.uuid, role: v.role };
    this.lostNotice = null;
    const lines = [`역할 '${v.role}' 선택됨`, `계정 UUID: ${res.uuid}`];
    if (description !== undefined) {
      const p = await this.client.setProfile(description);
      if (!p.ok) lines.push(`(설명 저장 실패: ${p.error})`);
    }
    const who = await this.client.whoami();
    lines.push(`이름: ${who.name ?? v.role}`);
    if (who.description) lines.push(`설명: ${who.description}`);
    if (res.source !== "env") {
      lines.push(`(고정하려면 MCP 설정 env의 UPLINK_ACCOUNTS에 "${v.role}=${res.uuid}" 를 추가하세요 — 다른 설정·PC에서도 같은 계정을 씁니다.)`);
    }
    if (!res.persisted) lines.push("(경고: 역할을 저장하지 못해 재시작 시 이 계정으로 복귀할 수 없습니다. 위 env 고정을 사용하세요.)");
    return { ok: true, text: lines.join("\n") };
  }
}
