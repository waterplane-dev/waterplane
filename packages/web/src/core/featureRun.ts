/**
 * The pure half of `dispatch.ts` and `sheets.ts`: the registry and the core are
 * PARAMETERS here, so `core.test.mjs` can drive them under `node --test` with a
 * fake registry — the real one pulls every feature's React tree in.
 *
 * A feature that throws is contained to itself (the next feature still hears
 * the frame), logged, and SAID once: the first failure per (feature, what)
 * becomes a toast and a `feature-fail:<id>` count, so a feature that stopped
 * working is a sentence on the phone and a number in the usage log, not only a
 * console line nobody on a phone will ever read. Once per key, because a
 * handler that throws on every `session.list` would otherwise toast forever.
 */
import { logTag } from "@waterplane/shared";
import type { ReactNode } from "react";
import type { HostMessage, RepoTarget, SessionInfo } from "@waterplane/shared";
import { addSettingRows } from "../settingsIndex.ts";
import type { ComponentType } from "react";
import type {
  Availability, ContributionIcon, CoreApi, FeatureManifest, LauncherItemCount, LauncherItemDef, MenuItemDef, RepoChipDef, SecretFillContext, SecretFillerDef, SessionViewDef, SettingsGroupId, SetupRowDef, SheetDef, SheetId, ToolbarItemDef,
} from "../sdk/types.ts";

type AnyHandler = (msg: HostMessage, c: CoreApi) => void;

export interface FeatureRunner {
  dispatch(msg: HostMessage): void;
  /** False when no feature owns `id`, so the caller's own fall-through is unchanged. */
  runCommand(id: string): boolean;
  /** Every feature's `boot`, once; the returned function runs their cleanups. */
  boot(): () => void;
}

type Fail = (feature: string, what: string, e: unknown, c: CoreApi | null) => void;

/**
 * Log every failure; SAY the first per (feature, what). With `deferred`, the
 * toast waits a microtask: a failure caught while a sheet is RENDERING must not
 * set another component's state in the middle of that render.
 */
export function createFailReporter(deferred = false): Fail {
  const said = new Set<string>();
  return (feature, what, e, c) => {
    console.error(`${logTag} feature ${feature} failed on ${what}`, e);
    const key = `${feature}\u0000${what}`;
    if (said.has(key) || !c) return;
    said.add(key);
    const say = () => {
      try {
        c.say.toast(`${feature} stopped handling ${what}`);
        c.say.track(`feature-fail:${feature}`);
      } catch (e2) { console.error(`${logTag} could not report a feature failure`, e2); }
    };
    if (deferred) queueMicrotask(say); else say();
  };
}

export function createFeatureRunner(features: readonly FeatureManifest[], getCore: () => CoreApi): FeatureRunner {
  // `t` → the handlers for it, in registry order. Built once: the registry is
  // static and `dispatch` runs on every frame the socket delivers.
  const handlers = new Map<string, { id: string; fn: AnyHandler }[]>();
  for (const f of features) {
    for (const [t, fn] of Object.entries(f.messages ?? {})) {
      if (!fn) continue;
      const list = handlers.get(t) ?? [];
      list.push({ id: f.id, fn: fn as AnyHandler });
      handlers.set(t, list);
    }
  }
  // `plugin.push`: `id\0event` → handler. Only the manifest whose id IS `msg.plugin` hears it.
  const pushes = new Map<string, { id: string; fn: (data: unknown, c: CoreApi) => void }>();
  for (const f of features) for (const [ev, fn] of Object.entries(f.pushes ?? {})) pushes.set(`${f.id}\u0000${ev}`, { id: f.id, fn });
  const commands = new Map(features.flatMap((f) => (f.commands ?? []).map((c) => [c.id, { feature: f.id, run: c.run }] as const)));
  const fail = createFailReporter();

  return {
    dispatch(msg) {
      if (msg.t === "plugin.push") {
        const p = pushes.get(`${msg.plugin}\u0000${msg.event}`);
        if (p) {
          const c = getCore();
          try { p.fn(msg.data, c); } catch (e) { fail(p.id, `push ${msg.event}`, e, c); }
        }
      }
      const list = handlers.get(msg.t);
      if (!list) return;
      const c = getCore();
      for (const h of list) {
        try { h.fn(msg, c); } catch (e) { fail(h.id, msg.t, e, c); }
      }
    },
    runCommand(id) {
      const cmd = commands.get(id);
      if (!cmd) return false;
      const c = getCore();
      try { cmd.run(c); } catch (e) { fail(cmd.feature, id, e, c); }
      return true;
    },
    boot() {
      const c = getCore();
      const undo: (() => void)[] = [];
      for (const f of features) {
        try {
          const u = f.boot?.(c);
          if (typeof u === "function") undo.push(u);
        } catch (e) { fail(f.id, "boot", e, c); }
      }
      return () => { for (const u of undo.reverse()) u(); };
    },
  };
}

/** The sheet table's lookups, over any registry. */
export function createSheetTable(features: readonly FeatureManifest[]) {
  // An extension's sheet id is `feature:<its manifest id>/<name>`: one naming another's prefix would
  // be drawn over that extension's sheet, so it is dropped (and logged) at build time.
  const ownsId = (f: FeatureManifest, s: SheetDef): boolean => {
    if (!String(s.id).startsWith("feature:")) return true;
    if (String(s.id).startsWith(`feature:${f.id}/`)) return true;
    console.error(`${logTag} feature ${f.id} declares sheet ${s.id}, which is not under feature:${f.id}/ — dropped`);
    return false;
  };
  const sheets = new Map<SheetId, SheetDef>(features.flatMap((f) => (f.sheets ?? []).filter((s) => ownsId(f, s)).map((s) => [s.id, s] as const)));
  return {
    sheets,
    /** The overlay changed from `prev` to `next`: the sheet that stopped being
     *  on top gets its `onLeave`. */
    leave(prev: string | null, next: string | null): void {
      if (!prev || prev === next) return;
      sheets.get(prev as SheetId)?.onLeave?.();
    },
  };
}

/** A rendered piece with a key that is stable across renders (feature id +
 *  position in its manifest), so the caller can hand React a list. */
export interface KeyedNode { key: string; node: ReactNode }

/**
 * Feature rows for one Settings group: `order` first, then registry order. A
 * `render` that throws drops that feature's rows (the rest of the group still
 * draws) and is said once, like a handler.
 */
export function createSettingsRowTable(features: readonly FeatureManifest[], getCore: () => CoreApi) {
  const defs = features.flatMap((f) => (f.settings ?? []).map((d, i) => ({ feature: f.id, key: `${f.id}:${i}`, d })));
  addSettingRows(defs.flatMap((x) => (x.d.rows ?? []).map((r) => ({ ...r, group: x.d.group }))));
  const fail = createFailReporter(true);
  return {
    /** `band` cuts the group's rows to `from <= order < to` — so the core sheet
     *  can draw a feature's row at the head of a group, or inside a rack, and
     *  not only at the end. Omitted = every row of the group. */
    rows(group: SettingsGroupId, band?: { from?: number; to?: number }): KeyedNode[] {
      const lo = band?.from ?? -Infinity;
      const hi = band?.to ?? Infinity;
      const mine = defs.filter((x) => x.d.group === group && x.d.order >= lo && x.d.order < hi);
      if (!mine.length) return [];
      const c = getCore();
      const out: KeyedNode[] = [];
      // `sort` is stable, so equal `order`s keep registry order.
      for (const x of [...mine].sort((a, b) => a.d.order - b.d.order)) {
        try { out.push({ key: x.key, node: x.d.render(c) }); } catch (e) { fail(x.feature, `settings:${group}`, e, c); }
      }
      return out;
    },
  };
}

/**
 * Feature-drawn toolbar items by id. `undefined` = no feature declares `id`, so
 * the core's own arm runs; `null` = the feature says "not now" — or threw,
 * which hides the item rather than taking the header down with it.
 */
export function createToolbarItemTable(features: readonly FeatureManifest[], getCore: () => CoreApi) {
  const items = new Map<string, { feature: string; d: ToolbarItemDef }>(
    features.flatMap((f) => (f.toolbarItems ?? []).map((d) => [d.id, { feature: f.id, d }] as const)));
  const fail = createFailReporter(true);
  return {
    item(id: string, ctx: Parameters<ToolbarItemDef["render"]>[1]): ReactNode | null | undefined {
      const it = items.get(id);
      if (!it) return undefined;
      const c = getCore();
      try { return it.d.render(c, ctx); } catch (e) { fail(it.feature, `toolbar:${id}`, e, c); return null; }
    },
  };
}

/** One repo-menu line, resolved for one repo. */
export interface RepoActionItem {
  key: string;
  /** The manifest id that declared it (the boundary's name). */
  feature: string;
  id: string;
  icon: ComponentType<{ size?: number | string }>;
  label: string;
  title?: string;
  run(): void;
}

/**
 * Repo actions for a repo's "⋯" menu, registry order. A `label` of null leaves the entry out (never a
 * grey control); a `label`/`title` that throws drops that entry and is said once; a `run` that throws
 * is contained and said once.
 */
export function createRepoActionTable(features: readonly FeatureManifest[], getCore: () => CoreApi) {
  const defs = features.flatMap((f) => (f.repoActions ?? []).map((d) => ({ feature: f.id, d })));
  const fail = createFailReporter(true);
  return {
    actions(repo: RepoTarget): RepoActionItem[] {
      if (!defs.length) return [];
      const c = getCore();
      const out: RepoActionItem[] = [];
      for (const { feature, d } of defs) {
        try {
          const label = d.label(repo, c);
          if (label == null) continue;
          const title = d.title?.(repo);
          out.push({
            key: `${feature}:${d.id}`, feature, id: d.id, icon: d.icon, label, ...(title ? { title } : {}),
            run: () => { const cc = getCore(); try { d.run(repo, cc); } catch (e) { fail(feature, `repo action ${d.id}`, e, cc); } },
          });
        } catch (e) { fail(feature, `repo action ${d.id}`, e, c); }
      }
      return out;
    },
  };
}

/** Repo chips in registry order: the defs themselves, each under a key stable across renders. */
export function createRepoChipList(features: readonly FeatureManifest[]): { key: string; feature: string; def: RepoChipDef }[] {
  return features.flatMap((f) => (f.repoChips ?? []).map((def) => ({ key: `${f.id}:${def.id}`, feature: f.id, def: def as RepoChipDef })));
}

/** Every feature's setup-row words, in registry order (`setupRowLookup` decides which are refused). */
export function setupRowDefs(features: readonly FeatureManifest[]): SetupRowDef[] {
  return features.flatMap((f) => [...(f.setupRows ?? [])]);
}

/**
 * A contributed session view or launcher item, resolved for this render: its words, and either the
 * open or the sentence why it cannot. `unavailable` set ⇒ the entry is still drawn like any other,
 * and its tap says the sentence (never a grey control).
 */
export interface ContributedEntry {
  /** `<manifest id>:<entry id>` — stable across renders, for React and for `track`. */
  key: string;
  feature: string;
  id: string;
  label: string;
  icon: ContributionIcon;
  unavailable: string | null;
  /** Contained: a throw is said once, never takes the header down. */
  open(): void;
  /** A launcher item's count HOOK (`LauncherItemDef.useCount`), passed through as given. */
  useCount?(): LauncherItemCount | null;
  /** A launcher item's tap while its count is above zero (`LauncherItemDef.openCount`), contained like `open`. */
  openCount?(): void;
}

/** The ONE reading of a count hook's answer: the badge's number, 0 when nothing waits. Every badge
 *  (the item's line, its header key, the ☰ sum) and the tap that picks `openCount` read it here. */
export function countedN(c: LauncherItemCount | null | undefined): number {
  return c && Number.isFinite(c.n) && c.n > 0 ? Math.floor(c.n) : 0;
}

/** The ☰ button's number: the core's own counts plus every counted item inside the menu. */
export function menuBadgeTotal(base: number, counts: readonly (LauncherItemCount | null | undefined)[]): number {
  return Math.max(0, base) + counts.reduce((n, c) => n + countedN(c), 0);
}

/** What `available` said, as the sentence or null. Anything but `true` or a non-empty string is a
 *  bug in the extension, and still reads as a refusal in words rather than as available. */
export function availabilityText(a: Availability | unknown, label: string): string | null {
  if (a === true) return null;
  if (typeof a === "string" && a.trim()) return a.trim();
  return `${label} is not available here`;
}

type Contributed = { id: string; label: string; icon: ContributionIcon; order?: number; available?(c: CoreApi): Availability };

function contributionTable<D extends Contributed, A extends unknown[]>(
  features: readonly FeatureManifest[], pick: (f: FeatureManifest) => readonly D[] | undefined, what: string,
  getCore: () => CoreApi, run: (d: D, c: CoreApi, ...args: A) => void,
) {
  // `order` first, then registry order (`sort` is stable).
  const defs = features
    .flatMap((f) => (pick(f) ?? []).map((d) => ({ feature: f.id, d })))
    .sort((a, b) => (a.d.order ?? 0) - (b.d.order ?? 0));
  const fail = createFailReporter(true);
  return {
    entries(...args: A): ContributedEntry[] {
      if (!defs.length) return [];
      const c = getCore();
      const out: ContributedEntry[] = [];
      for (const { feature, d } of defs) {
        try {
          const unavailable = d.available ? availabilityText(d.available(c), d.label) : null;
          out.push({
            key: `${feature}:${d.id}`, feature, id: d.id, label: d.label, icon: d.icon, unavailable,
            open: () => { const cc = getCore(); try { run(d, cc, ...args); } catch (e) { fail(feature, `${what} ${d.id}`, e, cc); } },
          });
        } catch (e) { fail(feature, `${what} ${d.id}`, e, c); }
      }
      return out;
    },
  };
}

/** Session views for the header's segment, `order` then registry order. An `available` that throws
 *  drops that view (said once); an `open` that throws is contained and said once. */
export function createSessionViewTable(features: readonly FeatureManifest[], getCore: () => CoreApi) {
  const t = contributionTable<SessionViewDef, [string]>(features, (f) => f.sessionViews, "session view", getCore,
    (d, c, sessionId) => d.open(c, { sessionId }));
  return { views: (sessionId: string) => t.entries(sessionId) };
}

/** Launcher header items, `order` then registry order, under the same containment. */
export function createLauncherItemTable(features: readonly FeatureManifest[], getCore: () => CoreApi) {
  const t = contributionTable<LauncherItemDef, []>(features, (f) => f.launcherItems, "launcher item", getCore, (d, c) => d.open(c));
  const counted = new Map<string, LauncherItemDef>();
  for (const f of features) for (const d of f.launcherItems ?? []) if (typeof d.useCount === "function") counted.set(`${f.id}:${d.id}`, d);
  const fail = createFailReporter(true);
  const withCount = (e: ContributedEntry, d: LauncherItemDef): ContributedEntry => ({
    ...e, useCount: d.useCount,
    ...(typeof d.openCount === "function" ? {
      openCount: () => { const c = getCore(); try { d.openCount!(c); } catch (err) { fail(e.feature, `launcher item ${d.id}`, err, c); } },
    } : {}),
  });
  return { items: () => t.entries().map((e) => { const d = counted.get(e.key); return d ? withCount(e, d) : e; }) };
}

/** A contributed menu line's catalog id: namespaced, so it can never take a core line's id. */
export const menuItemKey = (feature: string, id: string) => `${feature}:${id}`;

/** The contributed ☰ lines as catalog rows (`toolbar.ts`), `order` then registry order. */
export function menuItemCatalog(features: readonly FeatureManifest[]): { id: string; name: string; Icon: ContributionIcon }[] {
  return features
    .flatMap((f) => (f.menuItems ?? []).map((d) => ({ feature: f.id, d })))
    .sort((a, b) => (a.d.order ?? 0) - (b.d.order ?? 0))
    .map(({ feature, d }) => ({ id: menuItemKey(feature, d.id), name: d.label, Icon: d.icon }));
}

/** Contributed ☰ lines for one session, under the same containment as the launcher's items. The
 *  entry's `key` is its catalog id. */
export function createMenuItemTable(features: readonly FeatureManifest[], getCore: () => CoreApi) {
  const t = contributionTable<MenuItemDef, [SessionInfo]>(features, (f) => f.menuItems, "menu item", getCore, (d, c, active) => d.open(c, { active }));
  return { items: (active: SessionInfo) => t.entries(active) };
}

/** Contributed buttons for the masked password field, under the same containment. */
export function createSecretFillerTable(features: readonly FeatureManifest[], getCore: () => CoreApi) {
  const t = contributionTable<SecretFillerDef, [SecretFillContext]>(features, (f) => f.secretFillers, "secret filler", getCore, (d, c, ctx) => d.open(c, ctx));
  return { items: (ctx: SecretFillContext) => t.entries(ctx) };
}
