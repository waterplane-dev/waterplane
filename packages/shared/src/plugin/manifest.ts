import { pluginApiProblem, PLUGIN_API_VERSION } from "./version.js";
import { PLUGIN_BACKEND_ID_RE } from "./backend.js";
import { maturityProblems } from "../pluginmaturity.js";
import { BRAND, LEGACY } from "../brand.js";

/** What a plugin's methods take and answer — a type-level convenience only: args arrive from
 *  the wire UNCHECKED, so every handler validates. */
export type PluginMethods = { [method: string]: { args: unknown; result: unknown } };

/** What `plugin.call` resolves to on the phone. Never rejects. */
export type PluginCallResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

/** `plugin.push` event names, `plugin.call` ack ids, and the byte caps on args and pushed data. */
export const PLUGIN_EVENT_RE = /^[a-z][a-zA-Z0-9._-]{0,39}$/;
export const PLUGIN_ACK_RE = /^[A-Za-z0-9._:-]{1,80}$/;
export const PLUGIN_ARGS_MAX = 64 * 1024;
export const PLUGIN_PUSH_MAX = 64 * 1024;

/** `[a-z][a-z0-9-]{1,39}` — also the plugin's directory under `<state dir>/plugins/` (the host state dir, not the config dir). */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

export type PluginValue = boolean | string | number;

/** One setting, drawn by the app in the plugin's section of Settings. */
export type PluginField =
  | { kind: "switch"; key: string; label: string; note?: string; default: boolean }
  | { kind: "choice"; key: string; label: string; note?: string; default: string;
      options: { value: string; label: string }[] }
  | { kind: "number"; key: string; label: string; note?: string; default: number;
      min: number; max: number; step?: number; unit?: string }
  | { kind: "text"; key: string; label: string; note?: string; default: string;
      multiline?: boolean; placeholder?: string };

/** A button. `global` ones sit in the plugin's Settings section; `session` ones
 *  in a session's toolbar menu and receive that session's id. */
export interface PluginActionDef {
  id: string;
  label: string;
  note?: string;
  scope: "global" | "session";
}

/** A per-session switch the plugin reads (`api.session(id).toggles[id]`).
 *  Drawn in the session's toolbar menu; `default` applies until someone flips it. */
export interface PluginToggleDef {
  id: string;
  label: string;
  note?: string;
  default: boolean;
}

/** The manifest's file name, current and every past identity's (newest first;
 *  the loader accepts a legacy one with a deprecation line). */
export const PLUGIN_MANIFEST: string = BRAND.pluginManifest;
export const LEGACY_PLUGIN_MANIFESTS: readonly string[] = LEGACY.map((l) => l.pluginManifest);

/** `<config dir>/<PLUGIN_PATHS_FILE>` lists plugin directories kept elsewhere:
 *  `{ "paths": ["~/code/my-plugin"] }` (`~` expanded, relative to the config dir).
 *  Not the STATE dir's `plugins.json`, which holds the person's on/off switches. */
export const PLUGIN_PATHS_FILE = "plugin-paths.json";
/** That file's name before API 1.0.0; the loader renames an old one once, never deletes it. */
export const LEGACY_PLUGIN_PATHS_FILE = "plugins.json";

/** Caps on the manifest's `summary` and each `places` entry. */
export const PLUGIN_SUMMARY_MAX = 120;
export const PLUGIN_PLACE_MAX = 80;

/** The manifest, a JSON file named `PLUGIN_MANIFEST`. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** The plugin API this plugin was written against: semver (`"1.0"`), or a bare major
   *  (`1`, read as `1.0`). Checked by `pluginApiProblem` before any of its code runs. */
  apiVersion: string | number;
  description?: string;
  maturity?: "stable" | "preview" | "experimental"; // absent = "unrated" (`pluginMaturity`); "preview" is printed "Beta"
  /** One plain sentence (≤ `PLUGIN_SUMMARY_MAX` chars) saying what it does for the person. Absent = the
   *  phone falls back to the description. */
  summary?: string;
  /** Hand-written "where to find it" lines for places the web cannot derive from contributions
   *  (e.g. a host-only plugin's line on the usage meter). Each non-empty, ≤ `PLUGIN_PLACE_MAX` chars. */
  places?: string[];
  /** Host module, relative to the plugin dir. Absent ⇒ `host.mjs`. */
  host?: string;
  settings?: PluginField[];
  actions?: PluginActionDef[];
  toggles?: PluginToggleDef[];
  /** Environment variables the host module reads through `api.env()`. The
   *  phone shows set/unset for each, never a value. Only these are readable. */
  env?: string[];
  /**
   * The plugin may ANSWER a choice box unattended (`api.answer`). The core then
   * draws its own per-session switch, "let <name> answer", default OFF, and the
   * gate in `answerGate` decides every call — the plugin cannot skip it.
   */
  answers?: boolean;
  /** In-repo extensions only: the web half's source module, relative to the extension dir
   *  (`web/index.ts`). Compiled into the phone bundle, never loaded from outside the repo. */
  web?: string;
  /**
   * The backend ids this plugin will register with `api.backend()`. An id not
   * listed here is refused at registration, so what a plugin may add to the
   * launcher is readable from its manifest before it runs.
   */
  backends?: string[];
  /**
   * In-repo extensions only: the person may switch this one OFF (an ordinary
   * builtin is always on). Its default comes from the install's `release.json`
   * (`builtins`, written from `deploy/ship.json`), else on. Listed on the phone
   * so the switch can be reached.
   */
  optional?: boolean;
  /**
   * In-repo `optional` extensions only: the release default is narrowed PER DESKTOP by a
   * host-supplied probe this names (`AUTO_ON_PROBES`, a closed list — a manifest cannot invent
   * one, and core never runs extension code to decide whether the extension exists). Asked only
   * while the person has made no choice; their switch always wins and is never overwritten. An
   * unknown name is ignored (a newer manifest on an older daemon), so the extension reads as
   * plain `optional`.
   */
  autoOn?: AutoOnProbe;
  /** Folder (inside the extension) of static files served at `GET|HEAD /api/plugin/<id>/asset/<file>`; gated like `/api/*`, 403 while off. */
  assets?: string;
  /** Labelled "experimental" wherever its backends are listed (`BackendInfo.experimental`). */
  experimental?: boolean;
}

/** The probes a manifest's `autoOn` may name — the host supplies each one. */
export const AUTO_ON_PROBES = ["androidRepo"] as const;
export type AutoOnProbe = typeof AUTO_ON_PROBES[number];
/** The manifest's `autoOn` when this daemon knows the probe, else null. */
export function autoOnProbe(m: { autoOn?: unknown }): AutoOnProbe | null {
  return (AUTO_ON_PROBES as readonly unknown[]).includes(m.autoOn) ? m.autoOn as AutoOnProbe : null;
}

/** What the phone knows about one installed plugin. */
export interface PluginView {
  manifest: PluginManifest;
  /** Where it was loaded from — shown, so "which copy is this?" has an answer. */
  source: string;
  /** The person's switch. A disabled plugin is not activated at all. */
  enabled: boolean;
  /** `active` = activated; `error` = failed to load or activate (`error` says
   *  why, verbatim); `off` = disabled by the person. */
  state: "active" | "error" | "off";
  error?: string;
  /** Current settings, defaults filled in. */
  values: Record<string, PluginValue>;
  /** One line the plugin sets about itself ("no GEMINI_API_KEY — set it via the
   *  secret sheet"). */
  status?: PluginStatus | null;
  /** Declared env names → set or not. */
  env?: Record<string, boolean>;
  /** An `autoOn` extension's default as this desktop decided it — present ONLY while the person has
   *  made no choice (absent = their switch decides, or no probe applies). `why` is the sentence shown
   *  under the switch. */
  auto?: { state: "on" | "off"; why: string };
  /** Set by the host ONLY for an in-repo builtin whose own `ship.json` says `"ship": false` — an
   *  extension the public snapshot leaves out (like the vault). Absent = not private. */
  privacy?: "private";
  /** An in-repo extension that ships with the product (loaded from the bundle, not installed by the
   *  person). Absent = an outside plugin. */
  builtin?: true;
  /** A builtin that cannot be switched off (not `optional`, and started). Listed so the plugin manager
   *  shows every plugin; every older reader of the list skips these rows. Absent = switchable. */
  fixed?: true;
}

export interface PluginStatus {
  tone: "ok" | "warn" | "bad";
  text: string;
}


/** Validate a parsed manifest: problems in words (empty = valid). Unknown fields are allowed — a newer manifest on an older daemon loads with what it understands. */
export function manifestProblems(m: unknown): string[] {
  const out: string[] = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return [`${PLUGIN_MANIFEST} is not a JSON object`];
  const o = m as Record<string, unknown>;
  if (typeof o.id !== "string" || !PLUGIN_ID_RE.test(o.id)) out.push(`id must match ${PLUGIN_ID_RE}`);
  if (typeof o.name !== "string" || !o.name.trim()) out.push("name is required");
  if (typeof o.version !== "string") out.push("version is required");
  const api = pluginApiProblem(o.apiVersion, PLUGIN_API_VERSION, { backends: Array.isArray(o.backends) && o.backends.length > 0 }); if (api) out.push(api);
  const keys = new Set<string>();
  for (const f of Array.isArray(o.settings) ? o.settings as PluginField[] : []) {
    if (!f || typeof f.key !== "string" || !f.key) { out.push("a setting has no key"); continue; }
    if (keys.has(f.key)) out.push(`setting "${f.key}" is declared twice`);
    keys.add(f.key);
    if (!["switch", "choice", "number", "text"].includes(f.kind)) out.push(`setting "${f.key}" has unknown kind "${String(f.kind)}"`);
    if (f.kind === "number" && !(f.min <= f.default && f.default <= f.max)) out.push(`setting "${f.key}" default is outside min..max`);
    if (f.kind === "choice" && !f.options?.some((x) => x.value === f.default)) out.push(`setting "${f.key}" default is not one of its options`);
  }
  for (const a of Array.isArray(o.actions) ? o.actions as PluginActionDef[] : []) {
    if (!a?.id || !a.label) out.push("an action needs an id and a label");
    else if (a.scope !== "global" && a.scope !== "session") out.push(`action "${a.id}" scope must be global or session`);
  }
  for (const t of Array.isArray(o.toggles) ? o.toggles as PluginToggleDef[] : []) if (!t?.id || !t.label || typeof t.default !== "boolean") out.push("a toggle needs an id, a label and a boolean default");
  if (o.env !== undefined && (!Array.isArray(o.env) || o.env.some((e) => typeof e !== "string"))) out.push("env must be a list of names");
  if (o.web !== undefined && typeof o.web !== "string") out.push("web must be a path string");
  if (o.assets !== undefined && (typeof o.assets !== "string" || !o.assets || /^([\\/]|[A-Za-z]:)/.test(o.assets) || o.assets.split(/[\\/]/).includes(".."))) out.push("assets must be a folder path inside the extension (relative, no ..)");
  if (o.autoOn !== undefined && typeof o.autoOn !== "string") out.push("autoOn must be the name of a probe");
  for (const k of ["optional", "experimental"]) if (o[k] !== undefined && typeof o[k] !== "boolean") out.push(`${k} must be true or false`);
  if (o.summary !== undefined && (typeof o.summary !== "string" || !o.summary.trim() || o.summary.length > PLUGIN_SUMMARY_MAX)) out.push(`summary must be a non-empty line of at most ${PLUGIN_SUMMARY_MAX} characters`);
  if (o.places !== undefined) {
    if (!Array.isArray(o.places) || o.places.some((p) => typeof p !== "string" || !p.trim() || p.length > PLUGIN_PLACE_MAX)) out.push(`places must be a list of non-empty lines of at most ${PLUGIN_PLACE_MAX} characters`);
  }
  if (o.backends !== undefined) {
    if (!Array.isArray(o.backends)) out.push("backends must be a list of backend ids");
    else for (const b of o.backends) {
      if (typeof b !== "string" || !PLUGIN_BACKEND_ID_RE.test(b)) out.push(`backend id ${JSON.stringify(b)} is not a short lowercase word (letters, digits, dashes)`);
    }
  }
  return [...out, ...maturityProblems(o)];
}

/** A value as the manifest allows it, or undefined (refused, never repaired). */
export function cleanPluginValue(f: PluginField, v: unknown): PluginValue | undefined {
  switch (f.kind) {
    case "switch": return typeof v === "boolean" ? v : undefined;
    case "choice": return typeof v === "string" && f.options.some((o) => o.value === v) ? v : undefined;
    case "number": return typeof v === "number" && Number.isFinite(v) && v >= f.min && v <= f.max ? v : undefined;
    case "text": return typeof v === "string" && v.length <= 20_000 ? v : undefined;
  }
}

/** The settings with defaults filled in. */
export function pluginValues(m: PluginManifest, stored: Record<string, unknown>): Record<string, PluginValue> {
  const out: Record<string, PluginValue> = {};
  for (const f of m.settings ?? []) out[f.key] = cleanPluginValue(f, stored[f.key]) ?? f.default;
  return out;
}
