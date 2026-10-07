// 계정 선택 상태와 역할 흐름(use_account). MCP 툴 배선과 분리해 Hub를 상대로 테스트한다.
// 판단은 Hub의 code로만 한다(구버전 Hub는 code가 없어 LEGACY_* 문장 비교로 보완). 문구는 표시용이다.
import { HubClient } from "./hubClient.js";
import { RoleStore, validateRoleName } from "./roles.js";
import { oneLine } from "./text.js";
import { AccountStatus } from "../shared/protocol.js";
import { LEGACY_ACCOUNT_GONE, LEGACY_LOGIN_REQUIRED, LEGACY_UNKNOWN_OP, mcpMsg, type McpKey } from "./messages.js";

export interface Selection {
  uuid: string;
  role: string | null; // null = UPLINK_ACCOUNT 고정
}

type HubReply = { error?: string; code?: string };

/** Hub가 보낸 오류 문구를 AI 출력에 넣을 때: 다른 에이전트가 정한 이름이 섞여 있을 수 있어 한 줄로 정리한다(레드팀 RT24). */
function hubText(s: string | undefined): string {
  return oneLine(s ?? "", 500);
}

/** Hub에 그 op가 없음(구버전 Hub). */
export function isUnknownOp(r: HubReply): boolean {
  return r.code === "unknown_op" || r.error === LEGACY_UNKNOWN_OP;
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
      this.lostNotice = this.m("role_lost", { role: role ?? "?", reason });
    };
  }

  get selection(): Selection | null { return this.sel; }
  get pinned(): boolean { return this.roles === null; }

  /** 현재 언어의 문구(호출 때마다 언어를 다시 읽는다). */
  private m(key: McpKey, params?: object): string {
    return mcpMsg(this.client.lang(), key, params);
  }

  /** 계정이 필요한 툴의 관문. 선택 전이면 안내 문구, 선택됐으면 null. */
  async guard(): Promise<string | null> {
    if (this.sel) return null;
    const notice = this.lostNotice ? `${this.lostNotice}\n` : "";
    this.lostNotice = null;
    return `${notice}${this.m("select_first")}\n\n${await this.listText()}`;
  }

  /** 이 폴더의 역할 목록(설명·사용 상태 포함). */
  async listText(): Promise<string> {
    if (!this.roles) return this.m("pinned_session");
    const entries = this.roles.list();
    const statuses = new Map<string, AccountStatus>();
    if (entries.length > 0) {
      const r = await this.client.accountStatus(entries.map((e) => e.uuid));
      if (!r.ok) return isUnknownOp(r) ? this.m("old_hub") : this.m("role_status_failed", { detail: hubText(r.error) });
      for (const st of r.statuses ?? []) statuses.set(st.uuid, st);
    }
    const lines = entries.map((e) => {
      const st = statuses.get(e.uuid);
      const state = !st?.exists ? this.m("state_missing") : st.online ? this.m("state_in_use") : this.m("state_free");
      const pinned = e.source === "env" ? this.m("env_pinned_suffix") : "";
      const desc = st?.description ? ` — ${oneLine(st.description, 120)}` : "";
      const mine = this.sel?.uuid === e.uuid ? this.m("current_session_suffix") : "";
      return `- ${e.role} [${state}]${pinned}${desc}${mine}`;
    });
    const body = lines.length > 0 ? lines.join("\n") : this.m("no_roles");
    const ignored = this.roles.ignoredEnv();
    const tail = ignored.length > 0 ? `\n${this.m("ignored_env", { items: ignored.join(", ") })}` : "";
    return `${this.m("roles_header", { folder: this.roles.folder })}\n${body}${tail}`;
  }

  /** 역할을 선택(필요하면 생성)하고 독점 로그인한다. 실패 시 기존 선택을 유지한다. */
  async use(roleRaw: string, description?: string): Promise<{ ok: boolean; text: string }> {
    if (!this.roles) return { ok: false, text: this.m("pinned_cannot_switch") };
    const v = validateRoleName(roleRaw);
    if (!v.ok) return { ok: false, text: this.m(v.code, v.params) };
    const res = this.roles.resolve(v.role);
    // 구버전 Hub는 exclusive를 무시해 독점이 조용히 꺼진다 → 로그인 전에 역할 기능 지원을 확인한다.
    const probe = await this.client.accountStatus([res.uuid]);
    if (!probe.ok) return { ok: false, text: isUnknownOp(probe) ? this.m("old_hub") : this.m("role_check_failed", { detail: hubText(probe.error) }) };
    const r = await this.client.selectAccount(res.uuid, v.role);
    if (!r.ok) return { ok: false, text: `${hubText(r.error)}\n\n${await this.listText()}` };
    this.sel = { uuid: res.uuid, role: v.role };
    this.lostNotice = null;
    const lines = [this.m("role_selected", { role: v.role }), this.m("label_uuid", { uuid: res.uuid })];
    // 여기부터는 선택이 이미 성공했다 — 이후 단계의 실패는 결과 문구로만 알린다.
    if (description !== undefined) {
      try {
        const p = await this.client.setProfile(description);
        if (!p.ok) lines.push(this.m("profile_save_failed", { detail: hubText(p.error) }));
      } catch (e) {
        lines.push(this.m("profile_save_failed_retry", { detail: (e as Error).message }));
      }
    }
    try {
      const who = await this.client.whoami();
      lines.push(this.m("label_name", { name: oneLine(who.name ?? v.role, 80) }));
      if (who.description) lines.push(this.m("label_description", { description: oneLine(who.description, 500) }));
    } catch {
      lines.push(this.m("label_name", { name: v.role }));
    }
    if (res.source !== "env") lines.push(this.m("pin_hint", { role: v.role, uuid: res.uuid }));
    if (!res.persisted) lines.push(this.m("role_not_persisted"));
    return { ok: true, text: lines.join("\n") };
  }

  /** 계정 목록(이름·접속·설명, 한 줄씩). 역할 선택 전에도 쓴다. */
  async accountsText(): Promise<{ ok: boolean; text: string }> {
    const r = await this.client.listAccounts();
    if (!r.ok) {
      // 구버전 Hub는 list_accounts에 로그인을 요구한다 — 에이전트에는 login 툴이 없으므로 구버전 안내로 바꾼다.
      if (!this.sel && (r.code === "login_required" || r.error?.includes(LEGACY_LOGIN_REQUIRED))) return { ok: false, text: this.m("old_hub") };
      return { ok: false, text: this.explainError(r) };
    }
    const list = (r.accounts ?? []).map(
      (a) => `${oneLine(a.name, 80)}${a.online ? this.m("online_suffix") : ""} (${a.uuid})${a.description ? ` — ${oneLine(a.description, 120)}` : ""}`,
    );
    return { ok: true, text: list.length ? list.join("\n") : this.m("no_accounts") };
  }

  /** Hub 오류를 에이전트가 할 수 있는 행동으로 안내한다(에이전트에는 login 툴이 없다). */
  explainError(r: HubReply): string {
    if (isUnknownOp(r)) return this.m("old_hub");
    if (r.code === "account_gone" || r.error?.includes(LEGACY_ACCOUNT_GONE)) {
      if (!this.roles) return this.m("account_deleted_pinned");
      const role = this.sel?.role;
      this.sel = null;
      return this.m("account_deleted_role", { call: role ? `"${role}"` : "role" });
    }
    return this.m("failed", { detail: r.error ? hubText(r.error) : this.m("unknown_error") });
  }
}
