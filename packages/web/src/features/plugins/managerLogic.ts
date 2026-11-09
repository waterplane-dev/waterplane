/**
 * The plugin manager's rows, pure (the screen is `PluginManagerSheet`, drawn on top of this).
 *
 * One row per plugin the host lists (`plugin.list`, `fixed` builtins included), joined with the
 * extension's web half (its `FeatureManifest`, same id) for WHERE it shows up. Places are DERIVED
 * from the contributions, each with its own label, plus the manifest's hand-written `places`; the
 * ones that can be opened with no session (a Home-menu line, the Apps door) carry an `open`.
 *
 * Filters follow CLAUDE.md's "a count on a control is a filter": `filterMatches` is the ONE
 * bucketing function, `filterCounts` and `cutRows` both call it.
 */
import { pluginMaturity } from "@waterplane/shared";
import type { PluginView } from "@waterplane/shared";
import type { CoreApi, FeatureManifest } from "../../sdk";
import { SETTING_GROUPS } from "../../settingsIndex.ts";

export type ManagerState = "on" | "off" | "failed";
export type ManagerFilter = "all" | "on" | "off" | "beta" | "private";
export const MANAGER_FILTERS: readonly ManagerFilter[] = ["all", "on", "off", "beta", "private"];

/** One place a plugin shows up. `text` is the whole line ("Home menu: Desktop"). */
export interface ManagerPlace {
  key: string;
  /** Where ("Home menu"), then what ("Desktop"; empty when the place has no name of its own). */
  where: string;
  label: string;
  text: string;
  /** Present ONLY for a place that opens without a session (Home-menu line, Apps door). */
  open?: (core: CoreApi) => void;
  /** With `open`: the reason it cannot open right now (the contribution's own `available`), else null. */
  unavailable?: (core: CoreApi) => string | null;
}

export interface ManagerRow {
  /** React key: the load path. The manifest id is NOT unique (an external copy of a builtin's id is listed beside it as a failed row). */
  key: string;
  id: string;
  name: string;
  summary: string;
  state: ManagerState;
  stateLabel: string;
  error: string | null;
  maturity: { level: string; label: string };
  private: boolean;
  origin: "builtin" | "installed";
  /** Tags in print order: "Failed to load" (the only state tag; the switch says on/off), maturity (not "Unrated"), Private, Installed (a builtin is the default and unmarked). */
  tags: string[];
  /** The person may flip the switch. False for a `fixed` builtin: the row says why with `fixedWhy`. */
  canSwitch: boolean;
  fixedWhy: string | null;
  places: ManagerPlace[];
  /** Settings has something to narrow to (a section in the plugins row, or rows the extension adds). */
  hasSettings: boolean;
  status: PluginView["status"] | null;
  /** Declared env names not set on the desktop AND worth saying: the plugin is off or failing, or its status line is not ok. */
  needs: string[];
  view: PluginView;
}

/** The first sentence of a description, for a manifest with no `summary`. */
export function firstSentence(text: string | undefined): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return (m ? m[1]! : t).trim();
}

const humanId = (id: string) => id.replace(/[-_]+/g, " ");
const groupTitle = (g: string) => SETTING_GROUPS.find((x) => x.id === g)?.title ?? g;

function place(where: string, label: string, extra?: Pick<ManagerPlace, "open" | "unavailable">): ManagerPlace {
  const text = label ? `${where}: ${label}` : where;
  return { key: text, where, label, text, ...extra };
}

/** Pure: every place a web half contributes, in a stable order. */
export function derivePlaces(f: Pick<FeatureManifest, "launcherItems" | "menuItems" | "sessionViews" | "ledgerViews" | "settings" | "repoActions" | "repoChips" | "setupRows" | "appsDoor" | "tabMarks" | "secretFillers" | "imageText" | "toolbarItems"> | undefined): ManagerPlace[] {
  const out: ManagerPlace[] = [];
  if (!f) return out;
  const avail = (a?: (core: CoreApi) => true | string) => a ? (core: CoreApi) => { const r = a(core); return r === true ? null : r; } : () => null;
  for (const l of f.launcherItems ?? []) out.push(place("Home menu", l.label, { open: (core) => l.open(core), unavailable: avail(l.available) }));
  if (f.appsDoor) { const d = f.appsDoor; out.push(place("Apps", "", { open: (core) => d.open(core, { kind: "all" }) })); }
  for (const m of f.menuItems ?? []) out.push(place("Session menu", m.label));
  for (const v of f.sessionViews ?? []) out.push(place("Session header", v.label));
  for (const t of f.toolbarItems ?? []) out.push(place("Session toolbar", humanId(t.id)));
  for (const v of f.ledgerViews ?? []) out.push(place("Token statistics", v.label));
  for (const s of f.settings ?? []) {
    if (s.rows?.length) for (const r of s.rows) out.push(place("Settings", r.label));
    else out.push(place("Settings", groupTitle(s.group)));
  }
  for (const a of f.repoActions ?? []) out.push(place("Repo menu", humanId(a.id)));
  for (const c of f.repoChips ?? []) out.push(place("Repo row", `${humanId(c.id)} count`));
  if ((f.setupRows ?? []).length) out.push(place("Repo readings", ""));
  for (const t of f.tabMarks ?? []) out.push(place("Session tab", humanId(t.id)));
  for (const s of f.secretFillers ?? []) out.push(place("Password field", s.label));
  if (f.imageText) out.push(place("Annotator", "reads text"));
  return out;
}

const whereOf = (text: string) => (text.includes(":") ? text.slice(0, text.indexOf(":")) : text).trim();

/**
 * Pure: derived places plus the manifest's own. The manifest's words win where it speaks to the same
 * "where" (the derived "Repo menu: perms" is a humanized id; the manifest says "Repo menu: permission rules"),
 * EXCEPT a derived place that opens (a button): that stays and the manifest's line for the same where is dropped.
 */
export function mergePlaces(derived: readonly ManagerPlace[], manifest: readonly string[]): ManagerPlace[] {
  const own: ManagerPlace[] = [];
  const seen = new Set<string>();
  for (const raw of manifest) {
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    own.push({ key: text, where: whereOf(text), label: text.includes(":") ? text.slice(text.indexOf(":") + 1).trim() : "", text });
  }
  const openWhere = new Set(derived.filter((d) => d.open).map((d) => d.where));
  const ownWhere = new Set(own.map((o) => o.where));
  const keep = derived.filter((d) => d.open || !ownWhere.has(d.where));
  const mine = own.filter((o) => !openWhere.has(o.where));
  return [...keep, ...mine];
}

/** Pure: unset env names, only when they can be the reason (off, failed, or a status that is not ok). Declared env with a default is not a need. */
export function needsOf(p: PluginView, state: ManagerState): string[] {
  const unset = Object.entries(p.env ?? {}).filter(([, set]) => !set).map(([n]) => n);
  const trouble = state !== "on" || (p.status != null && p.status.tone !== "ok");
  return trouble ? unset : [];
}

/** Pure, display only: an absolute path shrinks to its last segment ("/opt/homebrew/bin/gemini" -> "gemini"). */
export function shortenPaths(text: string): string {
  return text.replace(/(?<![\w/.:~-])\/(?:[^\s/;,)"'`]+\/)+([^\s/;,)"'`]*[^\s/;,)"'`.])/g, "$1");
}

/** Pure: the place lines a card prints. A "Settings: x" line goes when the card has the Settings button itself. */
export function cardPlaces(r: Pick<ManagerRow, "places" | "hasSettings">): ManagerPlace[] {
  return r.hasSettings ? r.places.filter((p) => p.where !== "Settings") : r.places;
}

/** Pure: the row for one listed plugin. `feature` = its web half, if the bundle has one. */
export function managerRow(p: PluginView, feature: FeatureManifest | undefined): ManagerRow {
  const m = p.manifest;
  const rawM = pluginMaturity(m);
  const level = rawM.level === "unrated" && m.experimental === true ? "experimental" : rawM.level;
  const maturity = { level, label: level === rawM.level ? rawM.label : "Experimental" };
  const state: ManagerState = p.state === "error" ? "failed" : p.state === "off" || !p.enabled ? "off" : "on";
  const stateLabel = state === "failed" ? "Failed to load" : state === "on" ? "On" : "Off";
  const origin = p.builtin === true || p.fixed === true ? "builtin" : "installed";
  const places = mergePlaces(derivePlaces(feature), m.places ?? []);
  const tags: string[] = state === "failed" ? [stateLabel] : [];
  if (level !== "unrated") tags.push(maturity.label);
  if (p.privacy === "private") tags.push("Private");
  if (origin === "installed") tags.push("Installed");
  const fixed = p.fixed === true;
  return {
    key: p.source,
    id: m.id,
    name: m.name,
    summary: (m.summary ?? "").trim() || firstSentence(m.description),
    state, stateLabel,
    error: state === "failed" ? (p.error ?? "failed to start") : null,
    maturity,
    private: p.privacy === "private",
    origin, tags,
    canSwitch: !fixed,
    fixedWhy: fixed ? `${m.name} is built in and always on` : null,
    places,
    hasSettings: !fixed || places.some((x) => x.where === "Settings"),
    status: p.status ?? null,
    needs: needsOf(p, state),
    view: p,
  };
}

/** Pure: all rows, failed first (they need a look), then by name. `features` = the registry's manifests. */
export function managerRows(list: readonly PluginView[] | null, features: readonly Pick<FeatureManifest, "id">[]): ManagerRow[] {
  const byId = new Map(features.map((f) => [f.id, f as FeatureManifest]));
  // The web half belongs to the BUILTIN with that id only: an external copy sharing the id (a failed row) has none.
  const rows = (list ?? []).map((p) => managerRow(p, p.builtin === true ? byId.get(p.manifest.id) : undefined));
  return rows.sort((a, b) => Number(b.state === "failed") - Number(a.state === "failed") || a.name.localeCompare(b.name));
}

// ── filters: ONE bucketing function ────────────────────────────────────────

/** THE bucket: does this row belong under this filter? A failed row is under All only (it is neither on nor off). */
export function filterMatches(r: Pick<ManagerRow, "state" | "maturity" | "private">, f: ManagerFilter): boolean {
  switch (f) {
    case "all": return true;
    case "on": return r.state === "on";
    case "off": return r.state === "off";
    case "beta": return r.maturity.level === "preview" || r.maturity.level === "experimental";
    case "private": return r.private;
  }
}

/** The number on each chip — counted with `filterMatches`, so it is exactly what a tap shows. */
export function filterCounts(rows: readonly ManagerRow[]): Record<ManagerFilter, number> {
  const out = { all: 0, on: 0, off: 0, beta: 0, private: 0 } as Record<ManagerFilter, number>;
  for (const f of MANAGER_FILTERS) out[f] = rows.filter((r) => filterMatches(r, f)).length;
  return out;
}

export function cutRows(rows: readonly ManagerRow[], f: ManagerFilter): ManagerRow[] {
  return rows.filter((r) => filterMatches(r, f));
}

// closed: keys are this file's own ManagerFilter, never from the wire
export const FILTER_LABEL: Record<ManagerFilter, string> = { all: "All", on: "On", off: "Off", beta: "Beta", private: "Private" };

/** What the cut view says about itself; "" for All (nothing is hidden). */
export function filterNote(shown: number, total: number, f: ManagerFilter): string {
  if (f === "all") return "";
  return `${shown} of ${total} plugins: ${FILTER_LABEL[f]}`;
}
