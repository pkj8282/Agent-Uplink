// 렌더러의 순수 로직(DOM 없음 → Node에서 테스트).
import type { ConfigPatch, ConnEvent, ConnInviteInput, ConnProfile, ConnServerInput, NameConflict, StorageInput, StorageStatus, SupabaseInput, VerifyResult, Space1CreateInput, Space1JoinInput, Space1Status, RestoreReport, SecurityFinding, SnapshotAccount, SnapshotDm, TrashItem } from "../types.js";
import { oneLine } from "../text.js";
import type { AdminKey } from "../messages.js";
import { getLang, tr } from "./lang.js";
import { localeOf } from "../i18n.js";

export interface ConfigFormInput {
  maxChannelsPerServer: string;
  inboxMaxBatch: string;
  allowDevDelete: boolean;
}

export type ParseResult = { ok: true; patch: Required<Omit<ConfigPatch, "language">> } | { ok: false; error: string };

/** "1 이상 안전 정수" 문자열만 숫자로. 아니면 null. */
function posInt(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** 설정 폼 값을 검증해 Hub admin_set_config patch로 바꾼다(Hub도 재검증한다). */
export function parseConfigForm(input: ConfigFormInput): ParseResult {
  const max = posInt(input.maxChannelsPerServer);
  if (max === null) return { ok: false, error: tr("form_max_invalid") };
  const batch = posInt(input.inboxMaxBatch);
  if (batch === null) return { ok: false, error: tr("form_batch_invalid") };
  return { ok: true, patch: { maxChannelsPerServer: max, inboxMaxBatch: batch, allowDevDelete: input.allowDevDelete } };
}

export interface FormMessage { text: string; kind: "ok" | "err" | "dirty" }

/**
 * 설정 폼의 저장 상태. 저장 안 된 수정이 있으면 "저장됨" 표시를 지우고,
 * 새로고침이 사용자의 수정값을 조용히 덮어쓰지 못하게 한다(allowDevDelete 오인 방지).
 */
export class ConfigFormState {
  private dirty = false;
  /** 지금 보이는 상태 문구의 종류(문구는 언어를 바꾸면 다시 만든다). 실패 문구는 그 순간의 내용이라 다시 만들지 않는다. */
  private shown: "dirty" | "saved" | null = null;

  edit(): FormMessage {
    this.dirty = true;
    this.shown = "dirty";
    return this.message()!;
  }

  saved(): FormMessage {
    this.dirty = false;
    this.shown = "saved";
    return this.message()!;
  }

  failed(text: string): FormMessage {
    this.shown = null;
    return { text, kind: "err" };
  }

  /** 현재 언어로 다시 만든 상태 문구. 다시 만들 수 없는 것(실패·없음)은 null. */
  message(): FormMessage | null {
    if (this.shown === "dirty") return { text: tr("form_dirty"), kind: "dirty" };
    if (this.shown === "saved") return { text: tr("form_saved"), kind: "ok" };
    return null;
  }

  /** 새로고침 시 Hub 값으로 폼을 채워도 되는가. */
  acceptsRefresh(): boolean {
    return !this.dirty;
  }
}

export type DeleteTarget =
  | { kind: "channel"; name: string; serverName: string }
  | { kind: "server"; name: string; channelCount: number }
  | { kind: "account"; name: string; uuid: string; dmCount: number }
  | { kind: "dm"; names: string };


/** 확인창 등 평문 UI에 넣을 이름: 위장 문자(제어·방향·폭 0)를 정리하고 코드포인트 기준으로 자른다. */
export function displayName(s: string, max = 80): string {
  return oneLine(s, max);
}

const KIND_KEY: Record<TrashItem["kind"], AdminKey> = { channel: "kind_channel", server: "kind_server", account: "kind_account", orphan: "kind_orphan", dm: "kind_dm" };

export function trashKindLabel(kind: TrashItem["kind"]): string {
  return tr(KIND_KEY[kind]);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 휴지통 항목 제목: 채널은 '서버/채널'. */
export function trashTitle(t: TrashItem): string {
  return t.kind === "channel" && t.serverName !== undefined ? `${t.serverName}/${t.name}` : t.name;
}

export function trashFlags(t: TrashItem): string[] {
  const f: string[] = [];
  if (!t.intact) f.push(tr("flag_damaged"));
  if (t.dmLeftover) f.push(tr("flag_dm_left", { count: t.dmLeftover }));
  if (t.area === "connection") f.push(tr("flag_conn"));
  return f;
}

export function trashSummary(items: TrashItem[] | undefined): string {
  if (items === undefined) return tr("trash_unsupported");
  return tr("trash_summary", { count: items.length, size: formatBytes(items.reduce((s, t) => s + t.bytes, 0)) });
}

export function restoreConfirmMessage(t: TrashItem): string {
  // 이미 복원된 계정 항목의 남은 DM만 다시 붙이는 경우는 계정 복원 문구와 다르다(v3 Minor ③).
  if (t.dmLeftover !== undefined) return tr("restore_dm_leftover_confirm", { title: displayName(trashTitle(t)), count: t.dmLeftover });
  return tr("restore_confirm", { kind: trashKindLabel(t.kind), title: displayName(trashTitle(t)) });
}

/** 이름 충돌 확인 입력 창 문구(서버 충돌이 하나라도 있으면 허브 문구). */
export function conflictConfirmMessage(conflicts: NameConflict[]): string {
  const head = conflicts.some((c) => c.kind === "server")
    ? tr("conflict_server")
    : tr("conflict_channel");
  const lines = conflicts.map((c) => `${trashKindLabel(c.kind)}: ${displayName(c.name)} → ${displayName(c.to)}`);
  return `${head}\n\n${lines.join("\n")}`;
}

/** 복원 결과 문구. leftoverOnly = 이미 복원된 계정 항목의 남은 DM만 다시 붙이는 경우(항목에 dmLeftover가 있었음). */
export function restoreResultMessage(r: RestoreReport, opts: { leftoverOnly?: boolean } = {}): string {
  const parts = [tr(opts.leftoverOnly && r.dmsRestored === 0 ? "dm_restore_none" : "restored")];
  for (const x of r.renamed) parts.push(tr("renamed", { from: displayName(x.from), to: displayName(x.to) }));
  if (r.recreatedServer) parts.push(tr("server_recreated", { name: displayName(r.recreatedServer.name) }));
  if (r.dmsLeft) parts.push(tr("dms_left", { count: r.dmsLeft }));
  return parts.join(" ");
}

// 판단은 code로 한다 — 휴지통 작업 오류는 관리 앱이 더 자세한 문구로 바꾼다.
const CODE_KEY: Record<string, AdminKey> = {
  trash_missing: "op_trash_missing",
  trash_not_restorable: "op_trash_not_restorable",
  trash_bad_id: "op_trash_bad_id",
  channel_limit: "op_channel_limit",
  trash_busy: "op_trash_busy",
  dm_not_found: "op_dm_not_found",
  dm_member_missing: "op_dm_member_missing",
  dm_exists: "op_dm_exists",
  io_error: "op_io_error",
};

/** Hub 오류 코드 → 관리 앱 문구(현재 언어). 모르는 코드는 Hub가 보낸 원문(Hub도 같은 언어 설정을 따른다). */
export function opErrorMessage(code: string | undefined, fallback: string): string {
  const key = code && Object.hasOwn(CODE_KEY, code) ? CODE_KEY[code] : undefined;
  return key ? tr(key) : fallback;
}

/** 휴지통 비우기가 실제로 지울 항목(진행 중인 삭제·복원은 Hub가 남긴다). */
export function emptyTrashTargets(items: TrashItem[]): { count: number; bytes: number } {
  const done = items.filter((t) => !t.pending);
  return { count: done.length, bytes: done.reduce((s, t) => s + t.bytes, 0) };
}

export function emptyTrashConfirmMessage(count: number, bytes: number): string {
  return `${tr("empty_trash_confirm", { count, size: formatBytes(bytes) })}${tr("suffix_irreversible")}`;
}

/** 삭제 확인 대화상자 문구. */
export function deleteConfirmMessage(t: DeleteTarget): string {
  switch (t.kind) {
    case "channel":
      return `${tr("delete_channel_confirm", { server: displayName(t.serverName), name: displayName(t.name) })}${tr("suffix_to_trash")}`;
    case "server":
      return `${tr("delete_server_confirm", { name: displayName(t.name), count: t.channelCount })}${tr("suffix_to_trash")}`;
    case "account":
      return `${tr("delete_account_confirm", { name: displayName(t.name), uuid: displayName(t.uuid), count: t.dmCount })}${tr("suffix_to_trash")}`;
    case "dm":
      return `${tr("delete_dm_confirm", { names: displayName(t.names, 170) })}${tr("suffix_to_trash")}`;
  }
}

/** 동시에 여러 번 시작된 비동기 요청 중 마지막 것만 반영하기 위한 순번. */
export class LatestOnly {
  private n = 0;
  begin(): number { return ++this.n; }
  isLatest(t: number): boolean { return t === this.n; }
}

/** 마지막으로 본 시각 이후의 보안 기록 수(탭 알림). */
export function unseenCount(findings: SecurityFinding[] | undefined, lastSeen: number): number {
  return (findings ?? []).filter((f) => f.ts > lastSeen).length;
}

const FINDING_KEY: Record<string, AdminKey> = {
  control: "fk_control", separator: "fk_separator", bidi: "fk_bidi", zero_width: "fk_zero_width", tag: "fk_tag",
  variation_selector: "fk_variation_selector", filler: "fk_filler", format: "fk_format", ignorable: "fk_ignorable",
  surrogate: "fk_surrogate", emoji_smuggling: "fk_emoji_smuggling",
};

/** 종류별 개수: "태그 문자(숨은 ASCII) 28 · 폭 0 문자 1". 모르는 종류(새 Hub)는 기타. */
export function findingCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([k, n]) => `${tr(Object.hasOwn(FINDING_KEY, k) ? FINDING_KEY[k] : "fk_other")} ${n}`)
    .join(" · ");
}

/** 출처: 요청이면 op·항목·계정 이름, 디스크면 파일 종류·항목. 이름은 위장 문자를 정리한다. */
export function findingSource(f: SecurityFinding, accounts: SnapshotAccount[]): string {
  const parts = [tr(f.source === "request" ? "src_request" : "src_disk"), displayName(f.where, 40), displayName(f.field, 40)];
  if (f.source === "request" && f.account !== undefined) {
    const name = accounts.find((a) => a.uuid === f.account)?.name;
    parts.push(name !== undefined ? displayName(name) : tr("unknown_member", { id: displayName(f.account, 8) }));
  }
  return parts.join(" · ");
}

/** 그 계정이 멤버인 DM 수. */
export function dmCountOf(uuid: string, dms: SnapshotDm[]): number {
  return dms.filter((d) => d.members.includes(uuid)).length;
}

/** DM 멤버를 "이름 ↔ 이름"으로. 디렉터리에 없는 uuid는 앞 8자로 표시. */
export function memberNames(dm: SnapshotDm, accounts: SnapshotAccount[]): string {
  const byUuid = new Map(accounts.map((a) => [a.uuid, a.name]));
  return dm.members.map((u) => byUuid.get(u) ?? tr("unknown_member", { id: u.slice(0, 8) })).join(" ↔ ");
}

/** 계정 행의 보조 정보. online이 없으면(구버전 Hub) 접속 표시를 생략한다. */
export function accountMeta(online: boolean | undefined, dmCount: number): string {
  return online ? tr("meta_online", { count: dmCount }) : tr("meta_dms", { count: dmCount });
}

// ───── 통신(v3.0 2단계) ─────

const PROFILES: readonly ConnProfile[] = ["tls13-aes256gcm", "tls13-chacha20"];

/** 통신 서버 켜기 폼. 포트 0(임의)은 받지 않는다 — 초대 코드가 가리킬 고정 포트가 필요하다. */
export function parseServerForm(i: { port: string; profile: string; spaceName: string; burnOnJoin: boolean }):
  { ok: true; value: ConnServerInput } | { ok: false; error: string } {
  const port = posInt(i.port);
  if (port === null || port > 65535) return { ok: false, error: tr("form_port_invalid") };
  const profile = PROFILES.find((p) => p === i.profile);
  if (!profile) return { ok: false, error: tr("form_profile_invalid") };
  const spaceName = i.spaceName.trim();
  if (!spaceName) return { ok: false, error: tr("form_space_invalid") };
  return { ok: true, value: { port, profile, spaceName, burnOnJoin: i.burnOnJoin } };
}

/** 초대 만들기 폼. 유효 기간은 1~30일(Hub 상한과 같음). */
export function parseInviteForm(i: { label: string; host: string; days: string }):
  { ok: true; value: ConnInviteInput } | { ok: false; error: string } {
  const label = i.label.trim();
  if (!label) return { ok: false, error: tr("form_label_invalid") };
  const host = i.host.trim();
  if (!host) return { ok: false, error: tr("form_host_invalid") };
  const days = posInt(i.days);
  if (days === null || days > 30) return { ok: false, error: tr("form_days_invalid") };
  return { ok: true, value: { label, host, expiresInMs: days * 86_400_000 } };
}

/** 붙여 넣은 초대 코드: 앞뒤 공백만 자른다(중간 공백·줄바꿈은 Hub가 지운다). */
export function parseJoinCode(raw: string): string | null {
  const s = raw.trim();
  return s ? s : null;
}

export function serverEnableConfirmMessage(port: number): string {
  return tr("conn_enable_confirm", { port });
}

export function inviteConfirmMessage(label: string, host: string): string {
  return tr("conn_invite_confirm", { label: displayName(label), host: displayName(host, 253) });
}

export function revokeConfirmMessage(name: string): string {
  return tr("conn_revoke_confirm", { name: displayName(name) });
}

const EVENT_KEY: Record<string, AdminKey> = {
  join_failed: "ev_join_failed", auth_failed: "ev_auth_failed", rate_limited: "ev_rate_limited", listen_failed: "ev_listen_failed",
  space_connect_failed: "ev_space_connect_failed", frame_too_large: "ev_frame_too_large",
};

/** 통신 사건 한 줄(시각은 화면이 붙인다). 모르는 코드는 코드 그대로. */
export function connEventLine(e: ConnEvent): string {
  const d = e.detail ?? {};
  const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? displayName(String(v), 60) : "");
  if (e.code === "member_joined") return tr("ev_member_joined", { name: s(d.userName) });
  if (e.code === "member_revoked") return tr("ev_member_revoked", { name: s(d.userName) });
  if (e.code === "remote_text_too_long") return tr("ev_remote_text_too_long");
  if (e.code === "unclean_shutdown_detected") return tr("ev_unclean");
  if (e.code === "space1_member_joined") return tr("ev_s1_joined", { name: s(d.userName) });
  if (e.code === "space1_member_revoked") return tr("ev_s1_revoked", { name: s(d.userName) });
  if (e.code === "space1_sync_failed") return tr("ev_s1_sync_failed", { detail: connErrorMessage(typeof d.code === "string" ? d.code : undefined, s(d.code)) });
  if (e.code === "space1_fragment_rejected" || e.code === "space1_roster_rejected" || e.code === "space1_request_rejected") return tr("ev_s1_rejected");
  if (e.code === "prune_done") return tr("ev_prune_done", { removed: Number(d.removed) || 0 });
  if (e.code === "prune_skipped") return tr("ev_prune_skipped");
  if (e.code === "storage_uploaded") return tr("ev_storage_uploaded", { fragments: Number(d.fragments) || 0, messages: Number(d.messages) || 0 });
  if (e.code === "storage_upload_failed") return tr("ev_storage_upload_failed", { detail: connErrorMessage(typeof d.code === "string" ? d.code : undefined, s(d.code)) });
  if (Object.hasOwn(EVENT_KEY, e.code)) {
    const who = [d.ip, d.memberId, d.code, d.message, d.reason].map(s).filter(Boolean).join(" · ");
    return tr(EVENT_KEY[e.code], { who });
  }
  return displayName(e.code, 60);
}

const CONN_CODE_KEY: Record<string, AdminKey> = {
  server_not_enabled: "ce_server_not_enabled", server_not_found: "ce_server_not_found", port_invalid: "ce_port_invalid",
  profile_invalid: "ce_profile_invalid", host_invalid: "ce_host_invalid", expires_invalid: "ce_expires_invalid",
  name_invalid: "ce_name_invalid", shared_invalid: "ce_shared_invalid", member_not_found: "ce_member_not_found",
  invite_malformed: "ce_invite_malformed", invite_version: "ce_invite_version", invite_profile_unknown: "ce_invite_profile_unknown",
  invite_bad_signature: "ce_invite_bad_signature", invite_expired: "ce_invite_expired", pin_mismatch: "ce_pin_mismatch",
  cipher_mismatch: "ce_cipher_mismatch", tls_failed: "ce_tls_failed", unreachable: "ce_unreachable", timeout: "ce_timeout",
  join_failed: "ce_join_failed", relay_unsupported: "ce_relay_unsupported",
  storage_auth_failed: "ce_storage_auth_failed", storage_forbidden: "ce_storage_forbidden", storage_repo_not_found: "ce_storage_repo_not_found",
  storage_rate_limited: "ce_storage_rate_limited", storage_unreachable: "ce_storage_unreachable", storage_bad_response: "ce_storage_bad_response",
  storage_not_configured: "ce_storage_not_configured", storage_config_invalid: "ce_storage_config_invalid",
  space1_config_invalid: "ce_space1_config_invalid", space1_not_found: "ce_space1_not_found", space_not_found: "ce_space_not_found",
  invite_not_space: "ce_invite_not_space", space1_not_owner: "ce_space1_not_owner",
};

/** 통신 op 오류 코드 → 문구. 모르는 코드는 Hub 원문. */
export function connErrorMessage(code: string | undefined, fallback: string): string {
  return code && Object.hasOwn(CONN_CODE_KEY, code) ? tr(CONN_CODE_KEY[code]) : fallback;
}

export function connUnsupportedMessage(): string {
  return tr("conn_unsupported");
}

export function saveBlockedMessage(files: string[]): string {
  return tr("save_blocked", { files: files.map((f) => displayName(f, 60)).join(", ") });
}

/** 목록별로 마지막에 그린 값을 기억해, 바뀐 목록만 다시 그리게 한다(통신 탭 자동 갱신). */
export class ChangeGate {
  private last = new Map<string, string>();
  changed(key: string, value: unknown): boolean {
    const v = JSON.stringify(value);
    if (this.last.get(key) === v) return false;
    this.last.set(key, v);
    return true;
  }
  /** 다음 비교는 모두 '바뀜'(언어 변경·전체 새로고침 뒤 다시 그리기). */
  reset(): void {
    this.last.clear();
  }
}

// ───── 저장소(백업, v3.0 3a) ─────

/** 저장소 연결 폼. 저장소 이름 형식은 Hub와 같은 규칙(owner/name), 주기 1~60분. */
export function parseStorageForm(i: { repo: string; token: string; intervalMin: string }): { ok: true; value: StorageInput } | { ok: false; error: string } {
  const repo = i.repo.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) return { ok: false, error: tr("form_repo_invalid") };
  const token = i.token.trim();
  if (!token || /\s/.test(token)) return { ok: false, error: tr("form_token_invalid") };
  const n = posInt(i.intervalMin);
  if (n === null || n > 60) return { ok: false, error: tr("form_interval_invalid") };
  return { ok: true, value: { repo, token, intervalMin: n } };
}

export function storageStatusLine(st: StorageStatus): string {
  if (!st.configured) return tr("storage_off");
  const ref = /^https?:\/\/([^./]+)/.exec(st.url ?? "")?.[1] ?? "";
  const parts = [st.kind === "supabase" ? tr("storage_on_supabase", { ref: displayName(ref, 63), min: st.intervalMin ?? 5 }) : tr("storage_on", { repo: displayName(st.repo ?? ""), min: st.intervalMin ?? 5 })];
  parts.push(st.lastUploadAt ? tr("storage_last", { at: new Date(st.lastUploadAt).toLocaleString(localeOf(getLang())) }) : tr("storage_never"));
  if (st.lastError) parts.push(tr("storage_last_error", { detail: connErrorMessage(st.lastError, st.lastError) }));
  if (st.kind === "supabase" && st.lastError === "storage_unreachable") parts.push(tr("supabase_paused_hint"));
  if (st.prune?.enabled) parts.push(tr("prune_on", { days: st.prune.days }));
  return parts.join(" · ");
}

export function verifyResultMessage(r: VerifyResult): string {
  const head = tr("verify_counts", { fragments: r.fragments, messages: r.messages });
  if (r.breaks.length === 0 && r.missing.length === 0 && r.bad.length === 0) return `${head} ${tr("verify_ok")}`;
  const parts = [head];
  if (r.missing.length) parts.push(tr("verify_missing", { count: r.missing.length, list: r.missing.slice(0, 10).join(", ") }));
  if (r.breaks.length) parts.push(tr("verify_breaks", { count: r.breaks.length }));
  if (r.bad.length) parts.push(tr("verify_bad", { count: r.bad.length }));
  return parts.join(" · ");
}

// ───── 3b: 로컬 정리 ─────

export function parsePruneForm(i: { enabled: boolean; days: string }): { ok: true; value: { enabled: boolean; days: number } } | { ok: false; error: string } {
  const n = posInt(i.days);
  if (n === null || n < 7 || n > 365) return { ok: false, error: tr("form_prune_days_invalid") };
  return { ok: true, value: { enabled: i.enabled, days: n } };
}

// ───── Supabase(2026-11-07, Google Drive 대신) ─────

/** Supabase 연결 폼. 주소는 Hub와 같은 규칙(https://<ref>.supabase.co), 버킷은 비우면 agent-uplink. */
export function parseSupabaseForm(i: { url: string; key: string; bucket: string; intervalMin: string }): { ok: true; value: SupabaseInput } | { ok: false; error: string } {
  const url = i.url.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9]{1,63}\.supabase\.co$/.test(url)) return { ok: false, error: tr("form_supabase_url_invalid") };
  const key = i.key.trim();
  if (!key || /\s/.test(key)) return { ok: false, error: tr("form_token_invalid") };
  const bucket = i.bucket.trim() || "agent-uplink";
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(bucket)) return { ok: false, error: tr("form_bucket_invalid") };
  const n = posInt(i.intervalMin);
  if (n === null || n > 60) return { ok: false, error: tr("form_interval_invalid") };
  return { ok: true, value: { url, key, bucket, intervalMin: n } };
}

// ───── 공간(방식 1, v3.0 4단계 — GitHub만) ─────

export function parseS1CreateForm(i: { spaceName: string; localServerId: string; repo: string; token: string; intervalSec: string }): { ok: true; value: Space1CreateInput } | { ok: false; error: string } {
  const spaceName = i.spaceName.trim();
  if (!spaceName) return { ok: false, error: tr("form_space_invalid") };
  const localServerId = i.localServerId.trim();
  if (!localServerId) return { ok: false, error: tr("form_s1_server_invalid") };
  const repo = i.repo.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) return { ok: false, error: tr("form_repo_invalid") };
  const ghToken = i.token.trim();
  if (!ghToken || /\s/.test(ghToken)) return { ok: false, error: tr("form_token_invalid") };
  const n = posInt(i.intervalSec);
  if (n === null || n < 10 || n > 600) return { ok: false, error: tr("form_s1_interval_invalid") };
  return { ok: true, value: { spaceName, localServerId, repo, ghToken, intervalSec: n } };
}

export function parseS1JoinForm(i: { code: string; token: string }): { ok: true; value: Space1JoinInput } | { ok: false; error: string } {
  const code = i.code.trim();
  if (!code) return { ok: false, error: tr("form_code_empty") };
  const ghToken = i.token.trim();
  if (!ghToken || /\s/.test(ghToken)) return { ok: false, error: tr("form_token_invalid") };
  return { ok: true, value: { code, ghToken } };
}

export function space1StateLabel(role: Space1Status["role"], state: Space1Status["state"]): string {
  const r = tr(role === "owner" ? "s1_role_owner" : "s1_role_member");
  const st = tr(state === "active" ? "s1_state_active" : state === "pending" ? "s1_state_pending" : "s1_state_revoked");
  return `${r} · ${st}`;
}

export function space1RevokeConfirm(name: string): string {
  return tr("s1_revoke_confirm", { name: displayName(name) });
}

export function space1LeaveConfirm(name: string): string {
  return tr("s1_leave_confirm", { name: displayName(name) });
}
