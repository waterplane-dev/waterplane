/**
 * Skills and plugins switch — the wire (docs/analysis/skills-switch/PLAN.md). REST, no WebSocket
 * message. Every optional field means "this host did not say"; a value is never guessed.
 */

/** The `skillOverrides` values, in CLI rank order (on < name-only < user-invocable-only < off). */
export type SkillState = "on" | "name-only" | "user-invocable-only" | "off";
export const SKILL_STATES: readonly SkillState[] = ["on", "name-only", "user-invocable-only", "off"];
export type SkillSource = "personal" | "project" | "plugin" | "synced-skill" | "bundled";
export type SwitchLevel = "global" | "repo-local" | "repo-shared";

/** One settings file, as read. */
export interface SkillLayer {
  level: SwitchLevel;
  /** Display path ("~/.claude/settings.json", ".claude/settings.local.json"). */
  path: string;
  /** sha1 of the text, or "absent"; echoed back by a write. */
  rev: string;
  /** False: not JSON / not an object / a key is not an object. */
  readable: boolean;
  why?: string;
}

export interface SkillRow {
  kind: "skill";
  /** The `skillOverrides` key = the listing name. */
  id: string;
  source: SkillSource;
  /** Plugin id when `source === "plugin"`. */
  plugin?: string;
  /** Value at each level; ABSENT when that file has no key (not "on"). */
  set: Partial<Record<SwitchLevel, SkillState>>;
  effective: SkillState;
  from: SwitchLevel | "default" | "locked";
  locked?: string;
  /** Who fixed the value when `from` is "locked": the skill's own frontmatter (`disable-model-invocation`); absent = a managed setting. */
  lockedBy?: "author";
  /** Name + description line; ABSENT = unmeasured. */
  listingChars?: number;
  bodyChars?: number;
  /** `skillListingMaxDescChars` was set. */
  capped?: boolean;
  /** False for plugin skills (the CLI ignores `skillOverrides` for them). */
  switchable: boolean;
  why?: string;
  /** ABSENT while counting / no log. */
  uses?: { d30: number; all: number; typed30: number; typedAll: number };
}

export interface PluginRow {
  kind: "plugin";
  /** "sales@synced" = the `enabledPlugins` key. */
  id: string;
  name: string;
  version?: string;
  scope: string;
  set: Partial<Record<SwitchLevel, boolean>>;
  enabled: boolean;
  from: SwitchLevel | "default" | "locked";
  /** Ids of its SkillRows (read-only). */
  skills: string[];
  /** Sum of its skills' lines; ABSENT if any skill is unmeasured (`why` says so). */
  listingChars?: number;
  /** Names only; unsized, never 0. */
  mcpServers?: number;
  why?: string;
}

export interface SkillInventoryDoc {
  v: 1;
  at: number;
  repoId?: string;
  layers: SkillLayer[];
  rows: (SkillRow | PluginRow)[];
  /** A total always ships with its split. */
  totals: { skillChars?: number; pluginChars?: number; unmeasured: number };
  usage: { state: "ready" | "counting" | "absent"; done?: number; total?: number; why?: string; since30: number;
    /** `ready` on the previous scan's counts while a newer scan runs: the screen asks again. */ refreshing?: boolean };
  hostNote?: string;
}

/** `to: "inherit"` deletes the key at that level. */
export interface SkillChange { kind: "skill" | "plugin"; id: string; to: SkillState | boolean | "inherit" }
/** `revs`: the layer rev the screen read, keyed by level. */
export interface SkillWriteRequest { level: SwitchLevel; revs: Partial<Record<SwitchLevel, string>>; changes: SkillChange[] }
export type SkillWriteResponse =
  | { ok: true; file: string; changed: { id: string; from: string; to: string }[]; ignoredNote?: string; gitignored?: boolean; doc: SkillInventoryDoc }
  | { ok: false; error: string; status: 400 | 409 | 422 };

export interface SkillSuggestion {
  kind: "skill" | "plugin";
  id: string;
  to: "name-only" | "user-invocable-only" | "off";
  reason: string;
  savedChars?: number;
  uses30?: number;
  usesAll?: number;
}
export interface SkillRecommendResponse {
  ok: boolean;
  suggestions: SkillSuggestion[];
  note?: string;
  /** Model suggestions the host refused (unknown id, unswitchable, bad value). */
  dropped: number;
  spend?: { model?: string; costUsd?: number; inputTokens?: number; outputTokens?: number };
  error?: string;
  limited?: boolean;
}
