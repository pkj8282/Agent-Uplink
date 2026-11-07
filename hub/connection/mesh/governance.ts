// 망 거버넌스(방식 3, v3.0 5단계): DB 4가지 경우와 총괄 서버.
// - 각 서버는 자기 선택(경우·메인·예비)과 실제로 쓰는 경우를 서명해 알린다(case). 총괄을 인정했고 총괄이 경우를 정했으면 그것,
//   아니면 내 선택이 망의 모든 서버가 알린 선택과 같을 때만 그것, 다르면 분산화.
// - 총괄: 선언(coord)한 서버를 주인이 한 번 인정하면 그 서버의 서명 명령(cmd: case·cut·unshare·noWrite)을 묻지 않고 따른다.
//   명령은 번호가 늘어나는 것만(재전송 차단). 인정을 철회하면 그 총괄의 효과는 풀린다.
// - 명령이 할 수 없는 것: 공유 시작 강제·로컬 데이터 삭제·저장소 토큰 요구(그런 명령 종류가 없음).
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../fsutil.js";
import { openMesh, signMesh, type Signed } from "../../../shared/meshRecord.js";
import type { Mesh, MeshLink, MeshPolicy, MeshSelf } from "./mesh.js";

export type DbCase = "distributed" | "main" | "single";

export interface CaseChoice {
  case: DbCase;
  /** main·single: 메인(또는 전부 맡는) 서버 공간 ID. */
  main?: string;
  /** main: 예비 서버들. */
  standby: string[];
}

export type GovCommand =
  | { type: "case"; choice: CaseChoice }
  | { type: "cut"; target: string }
  | { type: "unshare"; target: string; ch: string }
  | { type: "noWrite"; entry: string; hubUser?: string };

interface CaseBody { origin: string; ver: number; choice: CaseChoice; effective: CaseChoice }
interface CoordBody { origin: string; ver: number; on: boolean }
interface CmdBody { origin: string; n: number; cmd: GovCommand }

interface Persisted {
  choice: CaseChoice;
  caseVer: number;
  coordVer: number;
  coordinator: boolean;
  cmdN: number;
  accepted: string | null;
  applied: number;
  /** 인정한 총괄의 명령 효과. */
  coordCase: CaseChoice | null;
  blocked: string[];
  unshared: { origin: string; ch: string }[];
  noWrite: { entry: string; hubUser?: string }[];
  lastEffective: string;
}

export interface GovernanceDeps {
  dir: string;
  self(): MeshSelf;
  mesh(): Mesh;
  /** 총괄 unshare가 내 채널을 가리킬 때: 내 망 공유에서 뺀다(로컬·참여자 공유는 그대로). */
  unshareOwn(ch: string): void;
  log(code: string, detail?: object): void;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CH_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CMDS = 500;
const DISTRIBUTED: CaseChoice = { case: "distributed", standby: [] };
export const RELAY_WINDOW = 500;

function cleanChoice(x: unknown): CaseChoice | null {
  if (!x || typeof x !== "object") return null;
  const c = x as Record<string, unknown>;
  if (c.case !== "distributed" && c.case !== "main" && c.case !== "single") return null;
  if (!Array.isArray(c.standby) || c.standby.length > 16 || !c.standby.every((s) => typeof s === "string" && ID_RE.test(s))) return null;
  if (c.case === "distributed") return { case: "distributed", standby: [] };
  if (typeof c.main !== "string" || !ID_RE.test(c.main)) return null;
  return { case: c.case, main: c.main, standby: c.case === "main" ? [...new Set(c.standby as string[])].filter((s) => s !== c.main).sort() : [] };
}

function cleanCmd(x: unknown): GovCommand | null {
  if (!x || typeof x !== "object") return null;
  const c = x as Record<string, unknown>;
  if (c.type === "case") { const ch = cleanChoice(c.choice); return ch ? { type: "case", choice: ch } : null; }
  if (c.type === "cut" && typeof c.target === "string" && ID_RE.test(c.target)) return { type: "cut", target: c.target };
  if (c.type === "unshare" && typeof c.target === "string" && ID_RE.test(c.target) && typeof c.ch === "string" && CH_RE.test(c.ch)) return { type: "unshare", target: c.target, ch: c.ch };
  if (c.type === "noWrite" && typeof c.entry === "string" && ID_RE.test(c.entry) && (c.hubUser === undefined || (typeof c.hubUser === "string" && c.hubUser.length <= 256))) {
    return { type: "noWrite", entry: c.entry, ...(c.hubUser !== undefined ? { hubUser: c.hubUser as string } : {}) };
  }
  return null;
}

const same = (a: CaseChoice | undefined | null, b: CaseChoice | undefined | null) => !!a && !!b && JSON.stringify(cleanChoice(a)) === JSON.stringify(cleanChoice(b));

export class Governance implements MeshPolicy {
  private st: Persisted;
  /** 망에서 받은 최신 알림(출처별). */
  private cases = new Map<string, Signed<CaseBody>>();
  private coords = new Map<string, Signed<CoordBody>>();
  private cmds = new Map<string, Signed<CmdBody>[]>();
  private mySigned: { kase: Signed<CaseBody> | null; coord: Signed<CoordBody> | null } = { kase: null, coord: null };

  constructor(private readonly deps: GovernanceDeps) {
    this.st = {
      choice: DISTRIBUTED, caseVer: 0, coordVer: 0, coordinator: false, cmdN: 0, accepted: null, applied: 0,
      coordCase: null, blocked: [], unshared: [], noWrite: [], lastEffective: "",
    };
    this.load();
  }

  // ───────── 저장 ─────────

  private file(n: string): string {
    return path.join(this.deps.dir, n);
  }

  private load(): void {
    try {
      const s = JSON.parse(fs.readFileSync(this.file("gov.json"), "utf8")) as Partial<Persisted>;
      this.st = { ...this.st, ...s, choice: cleanChoice(s.choice) ?? DISTRIBUTED, coordCase: s.coordCase ? cleanChoice(s.coordCase) : null };
    } catch { /* 처음 */ }
    try {
      const n = JSON.parse(fs.readFileSync(this.file("gov-net.json"), "utf8")) as { cases?: Record<string, Signed<CaseBody>>; coords?: Record<string, Signed<CoordBody>>; cmds?: Record<string, Signed<CmdBody>[]> };
      for (const [k, v] of Object.entries(n.cases ?? {})) this.cases.set(k, v);
      for (const [k, v] of Object.entries(n.coords ?? {})) this.coords.set(k, v);
      for (const [k, v] of Object.entries(n.cmds ?? {})) if (Array.isArray(v)) this.cmds.set(k, v.slice(-MAX_CMDS));
    } catch { /* 처음 */ }
  }

  private save(): void {
    fs.mkdirSync(this.deps.dir, { recursive: true });
    writeFileAtomic(this.file("gov.json"), JSON.stringify(this.st, null, 2));
  }

  private saveNet(): void {
    fs.mkdirSync(this.deps.dir, { recursive: true });
    writeFileAtomic(this.file("gov-net.json"), JSON.stringify({ cases: Object.fromEntries(this.cases), coords: Object.fromEntries(this.coords), cmds: Object.fromEntries(this.cmds) }));
  }

  // ───────── 정책(MeshPolicy) ─────────

  blocked(spaceId: string): boolean {
    return this.st.blocked.includes(spaceId);
  }

  channelBlocked(origin: string, ch: string): boolean {
    return this.st.unshared.some((u) => u.origin === origin && u.ch === ch);
  }

  noWrite(entry: string, hubUser: string): boolean {
    return this.st.noWrite.some((r) => r.entry === entry && (r.hubUser === undefined || r.hubUser === hubUser));
  }

  // ───────── 경우 ─────────

  choice(): CaseChoice {
    return this.st.choice;
  }

  setChoice(c: CaseChoice): void {
    const clean = cleanChoice(c);
    if (!clean) throw new Error("case_invalid");
    this.st.choice = clean;
    this.save();
    this.announceCase(true);
  }

  private others(): string[] {
    return this.deps.mesh().servers().map((s) => s.spaceId).filter((id) => !this.blocked(id));
  }

  /** 내가 따르는 총괄: 인정한 서버, 없으면 내가 총괄이면 나. */
  private leader(): string | null {
    return this.st.accepted ?? (this.st.coordinator ? this.deps.self().spaceId : null);
  }

  effectiveCase(): CaseChoice {
    if (this.leader() && this.st.coordCase) return this.st.coordCase;
    const mine = this.st.choice;
    if (mine.case === "distributed") return DISTRIBUTED;
    for (const id of this.others()) {
      const c = this.cases.get(id);
      if (!c || !same(c.body.choice, mine)) return DISTRIBUTED;
    }
    return mine;
  }

  private mirrorsAll(): string[] {
    const mesh = this.deps.mesh();
    return mesh.servers().filter((s) => !this.blocked(s.spaceId)).flatMap((s) => s.channels.filter((c) => !this.channelBlocked(s.spaceId, c.id)).map((c) => mesh.mirrorId(s.spaceId, c.id)));
  }

  /** 저장소에 무엇을 올릴지: own = 내 통신 채널, mirrors = 거울 채널 ID. */
  uploadPlan(): { own: boolean; mirrors: string[] } {
    const eff = this.effectiveCase();
    const me = this.deps.self().spaceId;
    if (eff.case === "distributed") return { own: true, mirrors: [] };
    if (eff.main === me) return { own: true, mirrors: this.mirrorsAll() };
    // 메인이 같은 경우를 실제로 쓰고 있다고 서명해 알렸을 때만 내 채널 올리기를 멈춘다(백업 공백 방지).
    const mainSaid = this.cases.get(eff.main!)?.body.effective;
    return { own: !same(mainSaid, eff), mirrors: [] };
  }

  private keepsFull(): boolean {
    const eff = this.effectiveCase();
    const me = this.deps.self().spaceId;
    return eff.case !== "distributed" && (eff.main === me || (eff.case === "main" && eff.standby.includes(me)));
  }

  /** 최근 500개로 잘라낼 거울 채널(메인·예비·지정 서버는 없음). */
  trimPlan(): string[] {
    return this.keepsFull() ? [] : this.mirrorsAll();
  }

  /** 처음 받는 사슬을 어디서부터 당길지. */
  initialWindow(): number {
    return this.keepsFull() ? Infinity : RELAY_WINDOW;
  }

  // ───────── 총괄 ─────────

  coordinators(): string[] {
    const out = [...this.coords.values()].filter((c) => c.body.on).map((c) => c.body.origin);
    if (this.st.coordinator) out.push(this.deps.self().spaceId);
    return out;
  }

  declareCoordinator(on: boolean): void {
    this.st.coordinator = on;
    this.st.coordVer++;
    if (!on && this.st.accepted === null) this.clearEffects();
    this.save();
    this.mySigned.coord = null;
    this.deps.mesh().flood({ event: "coord", m: this.myCoord() });
  }

  /** 총괄 인정(null이면 철회). 인정하면 그 총괄의 지난 명령을 순서대로 적용한다. */
  accept(spaceId: string | null): void {
    if (spaceId !== null && !this.coords.get(spaceId)?.body.on) throw new Error("not_coordinator");
    this.clearEffects();
    this.st.accepted = spaceId;
    this.st.applied = 0;
    this.save();
    if (spaceId) for (const m of this.cmds.get(spaceId) ?? []) this.applyCmd(m.body);
    this.deps.log(spaceId ? "gov_accepted" : "gov_accept_revoked", { spaceId });
    this.announceCase(false);
  }

  private clearEffects(): void {
    this.st.coordCase = null;
    this.st.blocked = [];
    this.st.unshared = [];
    this.st.noWrite = [];
    this.st.applied = 0;
    this.deps.mesh().refreshMirrors();
  }

  /** 총괄만: 명령을 서명해 망에 알리고 나에게도 적용. */
  issue(cmd: GovCommand): void {
    if (!this.st.coordinator) throw new Error("not_coordinator");
    const clean = cleanCmd(cmd);
    if (!clean) throw new Error("command_invalid");
    this.st.cmdN++;
    this.save();
    const m = signMesh<CmdBody>("cmd", { origin: this.deps.self().spaceId, n: this.st.cmdN, cmd: clean }, this.deps.self().keys);
    // 먼저 알리고 나서 적용 — cut 대상이 유일한 이웃이어도 명령이 망에 퍼지게
    this.deps.mesh().flood({ event: "cmd", m });
    if (this.st.accepted === null) this.applyCmd(m.body);
  }

  private applyCmd(b: CmdBody): void {
    if (b.n <= this.st.applied) return;
    this.st.applied = b.n;
    const me = this.deps.self().spaceId;
    const mesh = this.deps.mesh();
    const c = b.cmd;
    if (c.type === "case") this.st.coordCase = c.choice;
    else if (c.type === "cut" && c.target !== me && c.target !== b.origin) {
      if (!this.st.blocked.includes(c.target)) this.st.blocked.push(c.target);
      mesh.dropLinksTo(c.target);
      mesh.refreshMirrors();
    } else if (c.type === "unshare") {
      if (c.target === me) this.deps.unshareOwn(c.ch);
      else if (!this.channelBlocked(c.target, c.ch)) { this.st.unshared.push({ origin: c.target, ch: c.ch }); mesh.refreshMirrors(); }
    } else if (c.type === "noWrite") {
      if (!this.noWrite(c.entry, c.hubUser ?? "")) this.st.noWrite.push({ entry: c.entry, ...(c.hubUser !== undefined ? { hubUser: c.hubUser } : {}) });
    }
    this.save();
    this.deps.log("gov_command_applied", { type: c.type, n: b.n });
    this.announceCase(false);
  }

  private myCoord(): Signed<CoordBody> {
    if (!this.mySigned.coord) {
      this.mySigned.coord = signMesh<CoordBody>("coord", { origin: this.deps.self().spaceId, ver: Math.max(1, this.st.coordVer), on: this.st.coordinator }, this.deps.self().keys);
    }
    return this.mySigned.coord;
  }

  /** 내 선택·실제 경우 알림. force=false면 실제 경우가 바뀌었을 때만. */
  private announceCase(force: boolean): void {
    const eff = JSON.stringify(this.effectiveCase());
    if (!force && eff === this.st.lastEffective && this.mySigned.kase) return;
    this.st.lastEffective = eff;
    this.st.caseVer++;
    this.save();
    this.mySigned.kase = signMesh<CaseBody>("case", { origin: this.deps.self().spaceId, ver: this.st.caseVer, choice: this.st.choice, effective: this.effectiveCase() }, this.deps.self().keys);
    this.deps.mesh().flood({ event: "case", m: this.mySigned.kase });
  }

  /** 망 상태가 바뀌었을 수 있을 때(주기·목록 변경) — 실제 경우가 바뀌었으면 알린다. */
  tick(): void {
    this.announceCase(false);
  }

  // ───────── 망 이벤트 ─────────

  onAttach(l: MeshLink): void {
    if (!this.mySigned.kase) this.announceCase(true);
    l.ch.event({ event: "case", m: this.mySigned.kase! });
    if (this.st.coordinator || this.st.coordVer > 0) l.ch.event({ event: "coord", m: this.myCoord() });
    for (const m of this.cases.values()) l.ch.event({ event: "case", m });
    for (const m of this.coords.values()) l.ch.event({ event: "coord", m });
    for (const list of this.cmds.values()) for (const m of list) l.ch.event({ event: "cmd", m });
  }

  /** 거버넌스 이벤트면 처리하고 true. */
  onEvent(e: { event: string; [k: string]: unknown }, from: MeshLink): boolean {
    if (e.event !== "case" && e.event !== "coord" && e.event !== "cmd") return false;
    const kind = e.event;
    const b = openMesh<{ origin?: unknown; ver?: unknown; n?: unknown }>(kind, e.m);
    const mesh = this.deps.mesh();
    const reject = (code: string) => { this.deps.log(`mesh_reject_gov_${code}`, { spaceId: from.info.spaceId }); return true; };
    if (!b || typeof b.origin !== "string" || !ID_RE.test(b.origin)) return reject("bad");
    const me = this.deps.self().spaceId;
    if (b.origin === me || this.blocked(b.origin)) return true;
    const key = mesh.keyOf(b.origin);
    if (!key) return true; // 목록을 아직 모르는 출처 — 목록이 오면 다음 연결에서 다시 받음
    if ((e.m as Signed).signer !== key) return reject("forged");
    if (kind === "case") {
      const body = b as unknown as CaseBody;
      const choice = cleanChoice(body.choice), effective = cleanChoice(body.effective);
      if (typeof body.ver !== "number" || !choice || !effective) return reject("bad");
      const old = this.cases.get(b.origin);
      if (old && old.body.ver >= body.ver) return true;
      this.cases.set(b.origin, e.m as Signed<CaseBody>);
    } else if (kind === "coord") {
      const body = b as unknown as CoordBody;
      if (typeof body.ver !== "number" || typeof body.on !== "boolean") return reject("bad");
      const old = this.coords.get(b.origin);
      if (old && old.body.ver >= body.ver) return true;
      this.coords.set(b.origin, e.m as Signed<CoordBody>);
      if (!body.on && this.st.accepted === b.origin) this.accept(null); // 총괄이 내려오면 인정도 풀림
    } else {
      const body = b as unknown as CmdBody;
      let apply: CmdBody | null = null;
      const cmd = cleanCmd(body.cmd);
      if (typeof body.n !== "number" || !Number.isInteger(body.n) || body.n < 1 || !cmd) return reject("bad");
      const list = this.cmds.get(b.origin) ?? [];
      if (list.some((m) => m.body.n >= body.n)) return true; // 같거나 예전 번호(재전송)
      list.push(e.m as Signed<CmdBody>);
      this.cmds.set(b.origin, list.slice(-MAX_CMDS));
      if (this.st.accepted === b.origin) apply = { origin: b.origin, n: body.n, cmd };
      this.saveNet();
      mesh.flood({ event: kind, m: e.m }, from); // 알린 뒤 적용(cut으로 연결이 먼저 끊기지 않게)
      if (apply) this.applyCmd(apply);
      return true;
    }
    this.saveNet();
    mesh.flood({ event: kind, m: e.m }, from);
    this.announceCase(false);
    return true;
  }

  status(): { choice: CaseChoice; effective: CaseChoice; coordinator: boolean; accepted: string | null; coordinators: string[]; blocked: string[]; unshared: { origin: string; ch: string }[]; noWrite: { entry: string; hubUser?: string }[]; upload: { own: boolean; mirrors: number }; commandsSeen: number } {
    const up = this.uploadPlan();
    return {
      choice: this.st.choice, effective: this.effectiveCase(), coordinator: this.st.coordinator, accepted: this.st.accepted,
      coordinators: this.coordinators().filter((id) => id !== this.deps.self().spaceId), blocked: this.st.blocked, unshared: this.st.unshared, noWrite: this.st.noWrite,
      upload: { own: up.own, mirrors: up.mirrors.length },
      commandsSeen: [...this.cmds.values()].reduce((n, l) => n + l.length, 0),
    };
  }
}
