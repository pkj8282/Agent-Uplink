// 관리 앱 왼쪽 목록·하위 탭(v3.1). DOM 없음 → Node에서 시험. 화면 전환은 renderer.ts의 selectSection.
import type { AdminKey } from "../messages.js";

export type SectionId = "app" | "limits" | "servers" | "accounts" | "security" | "multi" | "trash";
export interface NavItem { id: SectionId; key: AdminKey; subs?: readonly { id: string; key: AdminKey }[] }

export const NAV: readonly NavItem[] = [
  { id: "app", key: "nav_app" },
  { id: "limits", key: "nav_limits" },
  { id: "servers", key: "nav_servers", subs: [{ id: "local", key: "sub_local" }, { id: "multi", key: "sub_multi" }] },
  { id: "accounts", key: "nav_accounts", subs: [{ id: "local", key: "sub_local" }, { id: "multi", key: "sub_multi" }] },
  { id: "security", key: "nav_security" },
  { id: "multi", key: "nav_multi", subs: [{ id: "comms", key: "sub_comms" }, { id: "space1", key: "sub_space1" }, { id: "mesh", key: "sub_mesh" }, { id: "storage", key: "sub_storage" }] },
  { id: "trash", key: "nav_trash" },
];

export const FIRST_SECTION: SectionId = "app";

export function panelId(section: SectionId, sub?: string): string {
  return sub ? `panel-${section}-${sub}` : `panel-${section}`;
}

/** 다른 PC 쪽을 보여 주는 화면인가(2초 자동 갱신 조건). */
export function isMultiView(section: SectionId, sub: string | undefined): boolean {
  return section === "multi" || ((section === "servers" || section === "accounts") && sub === "multi");
}

export interface NavMemory { section: SectionId; subs: Partial<Record<SectionId, string>> }

/** localStorage에 기억한 위치. 알려진 칸·하위 탭만 받고, 손상·낯선 값이면 첫 화면. */
export function parseNavMemory(raw: string | null): NavMemory {
  const fallback: NavMemory = { section: FIRST_SECTION, subs: {} };
  if (!raw) return fallback;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return fallback; }
  if (!j || typeof j !== "object") return fallback;
  const { section, subs } = j as { section?: unknown; subs?: unknown };
  const item = NAV.find((n) => n.id === section);
  if (!item) return fallback;
  const out: NavMemory = { section: item.id, subs: {} };
  if (subs && typeof subs === "object") {
    for (const n of NAV) {
      const v = (subs as Record<string, unknown>)[n.id];
      if (typeof v === "string" && n.subs?.some((s) => s.id === v)) out.subs[n.id] = v;
    }
  }
  return out;
}
