/**
 * The desktops this phone knows — the storage half of `shared/hosts.ts`.
 *
 * One host is ACTIVE: its keys are the bare `waterplane.*` ones every other module
 * already reads. Every other host's keys are PARKED under `waterplane.h.<id>.`
 * (`storage.ts` `KEY_SCOPE` says which keys follow the host and which the
 * phone). The Android shell only: in a browser the page is served BY a host,
 * so there is exactly one and this module is never asked anything.
 *
 * **A switch is two phases, split by a reload.** The page that asks only
 * writes `waterplane.hostSwitch` and reloads. The park/restore runs at the next
 * boot (`hostBoot.ts`, the first import of `main.tsx`), before any module has
 * read a host key into memory or can write one back. Done in the asking page,
 * the pagehide flushes that follow (a draft, the link log, the queue) would
 * write the OLD host's memory into the NEW host's bare keys — and the next
 * park would then overwrite the new host's parked words with it.
 *
 * **Nothing here deletes words.** A removed host's parked keys stay, and its
 * row moves to `waterplane.hostsGone` so re-adding the same address reuses its id
 * and brings them back. The only removals are the ones `planHostSwitch`
 * orders: a bare key after its parked copy landed, and a parked key whose bare
 * key the app itself deleted while that host was active (the park is a mirror).
 */
import {
  bareKeyFor, cleanHostLan, defaultHostName, isHostId, newHostId, normalizeHostBase, normalizeHostName,
  parkPrefix, parseHostList, planHostMigration, planHostSwitch, serializeHostList,
  type HostLan, type ParkOp, type SavedHost,
} from "@waterplane/shared";
import { LS, demoSnapKey, isDeviceKey } from "./storage.ts";

/** The slice of `Storage` this needs — `localStorage`, or a Map in a test. */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/** `localStorage`, or null where it throws (private mode, blocked WebView). */
export function browserKV(): KV | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function allKeys(kv: KV): string[] {
  const out: string[] = [];
  for (let i = 0; i < kv.length; i++) { const k = kv.key(i); if (k != null) out.push(k); }
  return out;
}

/** A pending switch. `to: null` = no host afterwards (the last one removed).
 *  `parked`: `finishSwitch`'s own progress mark — every park copy (and the
 *  mirror's removals) landed; written BEFORE the first bare key is removed. */
export interface HostSwitch { from: string | null; to: string | null; drop?: string; parked?: true }

function parseSwitch(raw: string | null): HostSwitch | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const id = (x: unknown) => (isHostId(x) ? x : null);
    if (!v || typeof v !== "object") return null;
    const sw: HostSwitch = { from: id(v.from), to: id(v.to) };
    if (isHostId(v.drop)) sw.drop = v.drop;
    if (v.parked === true) sw.parked = true;
    return sw;
  } catch { return null; }
}

export function readHosts(kv: KV): SavedHost[] {
  return parseHostList(kv.getItem(LS.hosts)) ?? [];
}
export function readGone(kv: KV): SavedHost[] {
  return parseHostList(kv.getItem(LS.hostsGone)) ?? [];
}
export function activeHostId(kv: KV): string | null {
  const id = kv.getItem(LS.hostActive);
  return id && readHosts(kv).some((h) => h.id === id) ? id : null;
}
export function activeHostOf(kv: KV): SavedHost | null {
  const id = kv.getItem(LS.hostActive);
  return readHosts(kv).find((h) => h.id === id) ?? null;
}

function run(kv: KV, ops: readonly ParkOp[]): void {
  for (const op of ops) {
    if (op.op === "remove") { kv.removeItem(op.key); continue; }
    const v = kv.getItem(op.from);
    if (v !== null) kv.setItem(op.to, v);
  }
}

/** Copy a host's parked keys to bare. `onlyMissing`: never over a bare key that
 *  exists (the no-previous-host case, where bare leftovers are somebody's words). */
function restore(kv: KV, toId: string, onlyMissing: boolean): void {
  for (const k of allKeys(kv)) {
    const b = bareKeyFor(k, toId);
    if (!b || isDeviceKey(b)) continue;
    if (onlyMissing && kv.getItem(b) !== null) continue;
    const v = kv.getItem(k);
    if (v !== null) kv.setItem(b, v);
  }
}

/**
 * Carry out a pending switch, if one is written. Returns whether one was.
 *
 * Interrupt-safe at every step. `hostActive` moves to the target only once
 * every copy has landed and the old bare keys are gone, so a boot that finds
 * the marker with `hostActive` still on `from` redoes the work, and one that
 * finds it already on `to` redoes only the restore.
 *
 * **The redo must not re-PLAN the park once bare keys have started to go.**
 * The park is a mirror (a parked key whose bare key is missing is deleted),
 * and a replan after some or all bare removals sees those keys "missing" and
 * deletes their only copy — every draft, the queue, the pad. So the marker
 * gains `parked: true` after the copies and the mirror's removals and BEFORE
 * the first bare removal; a redo that finds it skips straight to removing
 * what is still bare (each already has its parked copy) and the commit.
 */
export function finishSwitch(kv: KV): boolean {
  const sw = parseSwitch(kv.getItem(LS.hostSwitch));
  if (!sw) { if (kv.getItem(LS.hostSwitch) !== null) kv.removeItem(LS.hostSwitch); return false; }
  const hosts = readHosts(kv);
  const current = kv.getItem(LS.hostActive);
  const to = sw.to && hosts.some((h) => h.id === sw.to) ? sw.to : null;
  if (sw.from !== null && current === sw.from) {
    // Park `from` (copies, then the mirror's removals, then the bare removals),
    // then restore `to`. With no target, `planHostSwitch` is handed an id
    // nothing can be parked under ("-" is not a host id): it parks, clears and
    // restores nothing.
    const ops = planHostSwitch(allKeys(kv), isDeviceKey, sw.from, to ?? "-");
    const toPrefix = parkPrefix(to ?? "-");
    const fromPrefix = parkPrefix(sw.from);
    const isRestore = (op: ParkOp) => op.op === "copy" && op.from.startsWith(toPrefix);
    const isPark = (op: ParkOp) => (op.op === "copy" && !isRestore(op)) || (op.op === "remove" && op.key.startsWith(fromPrefix));
    const isClear = (op: ParkOp) => op.op === "remove" && !op.key.startsWith(fromPrefix);
    if (!sw.parked) {
      run(kv, ops.filter(isPark));
      kv.setItem(LS.hostSwitch, JSON.stringify({ ...sw, parked: true }));
    }
    run(kv, ops.filter(isClear));
    // The commit point: everything of `from` is parked and gone from bare.
    if (to) kv.setItem(LS.hostActive, to); else kv.removeItem(LS.hostActive);
    run(kv, ops.filter(isRestore));
  } else if (sw.from === null || current === to) {
    // No previous host (first add, re-add after the last was removed), or a
    // boot interrupted after phase A: restore only.
    if (to) { kv.setItem(LS.hostActive, to); restore(kv, to, sw.from === null); }
  }
  // else: stale marker (the active host moved some other way) — drop it.
  if (sw.drop && sw.drop !== kv.getItem(LS.hostActive)) {
    const left = readHosts(kv);
    const gone = left.find((h) => h.id === sw.drop);
    if (gone) {
      kv.setItem(LS.hosts, serializeHostList(left.filter((h) => h.id !== sw.drop)));
      kv.setItem(LS.hostsGone, serializeHostList([gone, ...readGone(kv).filter((g) => g.id !== gone.id)]));
    }
  }
  const active = activeHostOf(kv);
  if (active) kv.setItem(LS.hostBase, active.base); else kv.removeItem(LS.hostBase);
  kv.removeItem(LS.hostSwitch);
  return true;
}

/**
 * Boot: a pending switch first, then the one-`hostBase`-era migration
 * (`planHostMigration` — idempotent, so this runs on every boot and writes
 * nothing once storage agrees with itself).
 */
export function bootHosts(kv: KV | null): void {
  if (!kv) return;
  try {
    finishSwitch(kv);
    repairDemoHost(kv);
    const m = planHostMigration({ hosts: kv.getItem(LS.hosts), active: kv.getItem(LS.hostActive), hostBase: kv.getItem(LS.hostBase) });
    if (m.writes.hosts !== undefined) kv.setItem(LS.hosts, m.writes.hosts);
    if (m.writes.active !== undefined) kv.setItem(LS.hostActive, m.writes.active);
    if (m.writes.hostBase !== undefined) kv.setItem(LS.hostBase, m.writes.hostBase);
  } catch { /* quota / blocked storage: the app starts on whatever is there */ }
}

// ── The list ──────────────────────────────────────────────────────────

export interface HostInput { name?: string; base: string; lan?: Partial<HostLan> | null }

export type HostEditResult = { ok: true; host: SavedHost; reused: boolean } | { ok: false; why: string };

function lanOf(lan: HostInput["lan"]): HostLan | null {
  if (!lan || !lan.base) return null;
  return cleanHostLan({ base: lan.base, ssids: lan.ssids ?? [], auto: lan.auto === true });
}

/**
 * Add a host to the list (not active — `requestSwitch` does that). The same
 * address as a host already listed is refused; the same address as a REMOVED
 * one reuses its id, and with it the drafts and queue parked under it.
 */
export function addHost(kv: KV, input: HostInput): HostEditResult {
  const base = normalizeHostBase(input.base);
  if (!base) return { ok: false, why: "Not an address. Use a host name or IP, optionally with a port." };
  const hosts = readHosts(kv);
  if (hosts.some((h) => h.base === base)) return { ok: false, why: "That address is already in the list." };
  const gone = readGone(kv);
  const back = gone.find((g) => g.base === base);
  const id = back?.id ?? newHostId([...hosts, ...gone].map((h) => h.id));
  const host: SavedHost = { id, name: normalizeHostName(input.name) ?? back?.name ?? defaultHostName(base), base };
  if (back?.legacy && !hosts.some((h) => h.legacy)) host.legacy = true;
  const lan = lanOf(input.lan);
  if (lan) host.lan = lan;
  kv.setItem(LS.hosts, serializeHostList([...hosts, host]));
  if (back) kv.setItem(LS.hostsGone, serializeHostList(gone.filter((g) => g.id !== back.id)));
  return { ok: true, host, reused: !!back };
}

/** Rename / re-address / change the LAN side of a listed host. Writing the
 *  active host's new address to `hostBase` is the caller's reload to make. */
export function updateHost(kv: KV, id: string, input: HostInput): HostEditResult {
  const hosts = readHosts(kv);
  const i = hosts.findIndex((h) => h.id === id);
  if (i < 0) return { ok: false, why: "That host is no longer in the list." };
  const base = normalizeHostBase(input.base);
  if (!base) return { ok: false, why: "Not an address. Use a host name or IP, optionally with a port." };
  if (hosts.some((h) => h.id !== id && h.base === base)) return { ok: false, why: "Another host already has that address." };
  const prev = hosts[i]!;
  const host: SavedHost = { id, name: normalizeHostName(input.name) ?? defaultHostName(base), base };
  if (prev.legacy) host.legacy = true;
  const lan = input.lan === undefined ? prev.lan ?? null : lanOf(input.lan);
  if (lan) host.lan = lan;
  const next = hosts.slice();
  next[i] = host;
  kv.setItem(LS.hosts, serializeHostList(next));
  if (kv.getItem(LS.hostActive) === id) kv.setItem(LS.hostBase, base);
  return { ok: true, host, reused: false };
}

/**
 * What removing `id` needs: an inactive host is just dropped from the list
 * (its parked keys stay); the ACTIVE one needs a switch first — to `next`, or
 * to nothing when it is the last.
 */
export function planRemove(kv: KV, id: string): { kind: "drop" } | { kind: "switch"; next: string | null } | null {
  const hosts = readHosts(kv);
  if (!hosts.some((h) => h.id === id)) return null;
  if (kv.getItem(LS.hostActive) !== id) return { kind: "drop" };
  return { kind: "switch", next: hosts.find((h) => h.id !== id)?.id ?? null };
}

/** Drop an INACTIVE host's row. Its parked keys and its IndexedDB stay. */
export function dropInactiveHost(kv: KV, id: string): boolean {
  if (kv.getItem(LS.hostActive) === id) return false;
  const hosts = readHosts(kv);
  const gone = hosts.find((h) => h.id === id);
  if (!gone) return false;
  kv.setItem(LS.hosts, serializeHostList(hosts.filter((h) => h.id !== id)));
  kv.setItem(LS.hostsGone, serializeHostList([gone, ...readGone(kv).filter((g) => g.id !== id)]));
  return true;
}

/** Write the marker `finishSwitch` carries out at the next boot. */
export function writeSwitch(kv: KV, sw: HostSwitch): void {
  // Any way out of the demo host — a tap on a real host, "add", "remove" —
  // ends the demo: the flag must not follow the person onto a real desktop.
  if (sw.from === DEMO_HOST_ID) kv.removeItem(LS.demo);
  kv.setItem(LS.hostSwitch, JSON.stringify(sw));
}

/** Reload onto the launcher: a route names a session of the host being left. */
export function reloadToLauncher(): void {
  try { history.replaceState(null, "", location.pathname); } catch { /* keep the url */ }
  location.reload();
}

// ── The page's calls (localStorage, reload) ───────────────────────────

/** Switch the active host: park this one's keys, restore `id`'s — at the next
 *  boot — and reload. A no-op onto the host already active. */
export function switchTo(id: string): boolean {
  const kv = browserKV();
  if (!kv) return false;
  const from = kv.getItem(LS.hostActive);
  if (from === id || !readHosts(kv).some((h) => h.id === id)) return false;
  writeSwitch(kv, { from: isHostId(from) ? from : null, to: id });
  reloadToLauncher();
  return true;
}

/** Remove a host. The active one is switched away from first (to the next in
 *  the list, or to the setup screen when it was the last), in the same boot. */
export function removeHost(id: string): "dropped" | "switching" | null {
  const kv = browserKV();
  if (!kv) return null;
  const plan = planRemove(kv, id);
  if (!plan) return null;
  if (plan.kind === "drop") return dropInactiveHost(kv, id) ? "dropped" : null;
  writeSwitch(kv, { from: id, to: plan.next, drop: id });
  reloadToLauncher();
  return "switching";
}

/** Add a host and make it active: the first-run form, and "add + switch". */
export function addAndActivate(input: HostInput): HostEditResult {
  const kv = browserKV();
  if (!kv) return { ok: false, why: "This phone's storage is not available." };
  const r = addHost(kv, input);
  if (!r.ok) return r;
  const from = kv.getItem(LS.hostActive);
  writeSwitch(kv, { from: isHostId(from) && readHosts(kv).some((h) => h.id === from) ? from : null, to: r.host.id });
  reloadToLauncher();
  return r;
}

export function listHosts(): SavedHost[] {
  const kv = browserKV();
  return kv ? readHosts(kv) : [];
}
export function activeHost(): SavedHost | null {
  const kv = browserKV();
  return kv ? activeHostOf(kv) : null;
}

// ── The demo, as a host ───────────────────────────────────────────────

/**
 * The demo is a `SavedHost` with a reserved id (demo-mode-plan.md §4), so it
 * gets the park/restore namespace, shows in the host switcher, and entering or
 * leaving it is the same two-phase switch as any other: the real host's drafts,
 * queue and settings are parked while it runs and are back exactly as they were
 * after. Its address is the `.invalid` TLD, which can never resolve — if the
 * demo transport were ever off, nothing could reach a real machine by mistake.
 */
export const DEMO_HOST_ID = "demohost";
export const DEMO_HOST_BASE = "http://demo.invalid:8770";

export function isDemoHost(h: { id: string } | string | null | undefined): boolean {
  return (typeof h === "string" ? h : h?.id) === DEMO_HOST_ID;
}

/** The saved hosts as the person's own: the demo row is not one. */
export function realHosts(hosts: readonly SavedHost[]): SavedHost[] {
  return hosts.filter((h) => !isDemoHost(h));
}

/** Where leaving the demo goes: the host it was entered from, else the first real one, else nowhere. */
function returnHostId(kv: KV): string | null {
  const real = realHosts(readHosts(kv));
  const was = kv.getItem(LS.demoReturn);
  return real.find((h) => h.id === was)?.id ?? real[0]?.id ?? null;
}

/**
 * The demo's row and its parked words never outlive the demo: "Try the demo"
 * means the beginning, and a stale row would offer a host that is not there.
 * Also repairs the one broken state — the demo is the active host but nothing
 * asks for it (the flag was cleared, the build lost the scenario) — by
 * switching back, so a person is never stranded on `demo.invalid`.
 */
export function repairDemoHost(kv: KV): void {
  if (kv.getItem(LS.hostActive) === DEMO_HOST_ID && !kv.getItem(LS.demo)) {
    writeSwitch(kv, { from: DEMO_HOST_ID, to: returnHostId(kv) });
    finishSwitch(kv);
  }
  if (kv.getItem(LS.hostActive) === DEMO_HOST_ID) return;
  // The flag without the host (an interrupted exit): a real desktop is not a demo.
  kv.removeItem(LS.demo);
  const list = readHosts(kv);
  if (list.some(isDemoHost)) kv.setItem(LS.hosts, serializeHostList(realHosts(list)));
  const gone = readGone(kv);
  if (gone.some(isDemoHost)) kv.setItem(LS.hostsGone, serializeHostList(realHosts(gone)));
  const prefix = parkPrefix(DEMO_HOST_ID);
  for (const k of allKeys(kv)) if (k.startsWith(prefix)) kv.removeItem(k);
}

/** The storage half of entering the demo (the page's reload is `enterDemoHost`'s). False when already in it. */
export function markDemoEnter(kv: KV, scenarioId: string): boolean {
  const from = kv.getItem(LS.hostActive);
  if (from === DEMO_HOST_ID) return false;
  const list = readHosts(kv);
  if (!list.some(isDemoHost)) {
    kv.setItem(LS.hosts, serializeHostList([...list, { id: DEMO_HOST_ID, name: "Demo", base: DEMO_HOST_BASE }]));
  }
  const fromId = isHostId(from) && list.some((h) => h.id === from) ? from : null;
  if (fromId) kv.setItem(LS.demoReturn, fromId); else kv.removeItem(LS.demoReturn);
  kv.setItem(LS.demo, scenarioId);
  writeSwitch(kv, { from: fromId, to: DEMO_HOST_ID });
  return true;
}

/** The storage half of leaving it: the flag off, and a switch back to where it was entered from. */
export function markDemoLeave(kv: KV): void {
  kv.removeItem(LS.demo);
  if (kv.getItem(LS.hostActive) === DEMO_HOST_ID) writeSwitch(kv, { from: DEMO_HOST_ID, to: returnHostId(kv) });
}

/** Enter the demo on this phone (Android shell): add the row, park the active host, reload into it. */
export function enterDemoHost(scenarioId: string): boolean {
  const kv = browserKV();
  if (!kv) return false;
  try { globalThis.sessionStorage?.removeItem(demoSnapKey(scenarioId)); } catch { /* storage off */ }
  if (!markDemoEnter(kv, scenarioId)) return false;
  // The route names a session of the host being left; the demo starts at the launcher.
  try { history.replaceState(null, "", location.pathname); } catch { /* keep the url */ }
  location.reload();
  return true;
}

/** Leave the demo (Android shell): back to the host it came from, or to host setup when there was none. */
export function leaveDemoHost(): boolean {
  const kv = browserKV();
  if (!kv) return false;
  const id = kv.getItem(LS.demo);
  try { if (id) globalThis.sessionStorage?.removeItem(demoSnapKey(id)); } catch { /* storage off */ }
  markDemoLeave(kv);
  try { history.replaceState(null, "", location.pathname); } catch { /* keep the url */ }
  location.reload();
  return true;
}
