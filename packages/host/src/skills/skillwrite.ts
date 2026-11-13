/**
 * Skills and plugins switch, write side (docs/analysis/skills-switch/PLAN.md, P3).
 *
 * One request writes ONE settings file, chosen from a FIXED table by `level` (never from the body).
 * Merge safety: the file is read raw, handed to `withSkillSettings` (touches only `skillOverrides`
 * and `enabledPlugins`), and an unparseable file is refused with nothing written and nothing moved
 * aside. A stale `rev` is a 409. The write goes through `writeTextAtomicKeepMode` (through a symlink,
 * mode kept; a repo file may not link out of the repo). Contents never reach a log line.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { savingsOf, withSkillSettings, type SkillChange, type SkillInventoryDoc, type SkillRow, type PluginRow, type SwitchLevel } from "@waterplane/shared";
import { claudeConfigDir } from "../claudeconfig.js";
import { writeTextAtomicKeepMode } from "../jsonstore.js";
import { containedReal } from "../paths.js";
import { displayPath } from "./skilllayers.js";
import { PLUGIN_SKILLS_SWITCHABLE, resetPluginListCache } from "./skillinventory.js";

export interface WriteInput {
  level: unknown;
  revs: unknown;
  changes: unknown;
  /** The levels this route may write: the host route only `global`. */
  allowed: readonly SwitchLevel[];
  /** The repo's worktree (already contained by the route layer); absent on the host route. */
  worktree?: string;
  /** The save record (`skillswitch-log.jsonl`): absent = no record (unit tests of the merge). */
  logFile?: string;
  /** The repo id for the record; absent on the host-wide route (recorded as null). */
  repoId?: string;
  /** The inventory read just now (the ids the host knows). */
  doc: SkillInventoryDoc;
}
export type WriteOutcome =
  | { ok: true; file: string; changed: { id: string; from: string; to: string }[]; ignoredNote?: string; gitignored?: boolean }
  | { ok: false; error: string; status: 400 | 409 | 422 };

/** One line of `<hostStateDir>/skillswitch-log.jsonl`: append-only, never rewritten (PLAN.md, "The save record"). */
export interface SkillSwitchLogLine {
  ts: string;
  repoId: string | null;
  level: SwitchLevel;
  file: string;
  changes: { kind: "skill" | "plugin"; id: string; from: string; to: string }[];
  listingCharsBefore: number;
  /** Before minus the saving `savingsOf` computes from the same rows: an estimate, like the screen's own figure. */
  listingCharsAfter: number;
}

/** Append one record. A failure is logged and never fails the write that already happened. No file contents, only ids. */
export function appendSkillSwitchLog(logFile: string, line: SkillSwitchLogLine): void {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, JSON.stringify(line) + "\n", { mode: 0o600 });
  } catch (e) {
    console.warn(`[skills] could not append the save record: ${(e as Error).message}`);
  }
}

const LEVELS: readonly SwitchLevel[] = ["global", "repo-local", "repo-shared"];
const bad = (error: string, status: 400 | 409 | 422): WriteOutcome => ({ ok: false, error, status });

export const revOf = (text: string | null): string => (text === null ? "absent" : createHash("sha1").update(text).digest("hex"));

/** The one file a level names: the fixed table. null = no worktree for a repo level. */
export function targetFile(level: SwitchLevel, worktree?: string): { abs: string; display: string } | null {
  if (level === "global") { const abs = join(claudeConfigDir(), "settings.json"); return { abs, display: displayPath(abs) }; }
  if (!worktree) return null;
  const rel = level === "repo-local" ? ".claude/settings.local.json" : ".claude/settings.json";
  const abs = containedReal(worktree, rel);
  return abs ? { abs, display: rel } : null;
}

export function applySkillWrite(input: WriteInput): WriteOutcome {
  const { level, revs, changes, doc, worktree } = input;
  if (typeof level !== "string" || !LEVELS.includes(level as SwitchLevel) || !input.allowed.includes(level as SwitchLevel)) {
    return bad("This screen cannot write that settings level from here.", 400);
  }
  const lvl = level as SwitchLevel;
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 500) return bad("Nothing to change, or too many changes in one go.", 400);
  const rev = revs && typeof revs === "object" ? (revs as Record<string, unknown>)[lvl] : undefined;
  if (typeof rev !== "string") return bad("The request must carry the revision this screen read for that file.", 400);

  const t = targetFile(lvl, worktree);
  if (!t) return bad(worktree ? `${lvl === "repo-local" ? ".claude/settings.local.json" : ".claude/settings.json"} resolves outside this repo — left as it is.` : "No repo for that level.", 400);

  // 1. Read raw; absent is fine, unreadable is not.
  let text: string | null = null;
  try { text = readFileSync(t.abs, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return bad(`${t.display} could not be read (${(e as NodeJS.ErrnoException).code ?? "error"}), left as it is.`, 422);
    // ENOENT on a path that exists as a link is a dangling symlink: writing would replace the link itself.
    let isLink = false;
    try { isLink = lstatSync(t.abs).isSymbolicLink(); } catch { /* really absent */ }
    if (isLink) return bad(`${t.display} is a link to a file that does not exist, so it is left as it is. Make the target file first.`, 422);
  }
  if (revOf(text) !== rev) return bad(`${t.display} changed on disk since this screen read it — reload.`, 409);

  // 2. Unparseable stops here, before the ids are judged (a person fixes the file first).
  let existing: Record<string, unknown> = {};
  if (text !== null && text.trim() !== "") {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) {
      return bad(`${t.display} is not valid JSON, so it is left as it is (${(e as Error).message}). Comments are not accepted either.`, 422);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad(`${t.display} is not a JSON object, left as it is.`, 422);
    existing = parsed as Record<string, unknown>;
  }
  const keyIn = (map: string, id: string): boolean => {
    const m = existing[map];
    return !!m && typeof m === "object" && !Array.isArray(m) && Object.prototype.hasOwnProperty.call(m, id);
  };

  // 3. Every change names something the inventory knows; plugin skills are read-only while the CLI ignores them.
  const rows = new Map<string, SkillRow | PluginRow>();
  for (const r of doc.rows) rows.set(`${r.kind}\0${r.id}`, r);
  const list = changes as SkillChange[];
  for (const c of list) {
    if (!c || typeof c !== "object") return bad("A change needs a kind and an id.", 400);
    const row = rows.get(`${c.kind}\0${c.id}`);
    if (!row) {
      const stale = c.to === "inherit" && keyIn(c.kind === "skill" ? "skillOverrides" : "enabledPlugins", String(c.id));
      if (!stale) return bad(`"${String(c.id).slice(0, 60)}" is not a ${c.kind} this desktop has.`, 400);
      continue;
    }
    if (row.kind === "skill") {
      if (row.source === "plugin" && !PLUGIN_SKILLS_SWITCHABLE) return bad(`${row.id} belongs to a plugin: its skills cannot be switched one by one, only the plugin as a whole.`, 400);
      if (row.locked) return bad(`${row.id}: ${row.locked}`, 400);
    } else if (row.from === "locked") {
      return bad(`${row.id} is fixed by a managed setting and cannot be changed here.`, 400);
    }
  }

  // 4. Merge (validates values too) and write.
  // A synced skill's bare key is a second spelling of the same switch (when no personal / project skill
  // holds the bare name): "use the default" must remove it too, or the button cannot do what it says.
  const toWrite: SkillChange[] = [...list];
  for (const c of list) {
    const row = rows.get(`${c.kind}\0${c.id}`);
    if (c.kind !== "skill" || c.to !== "inherit" || !row || row.kind !== "skill" || row.source !== "synced-skill") continue;
    const bare = c.id.replace(/^anthropic-skills:/, "");
    if (bare !== c.id && !rows.has(`skill\0${bare}`) && keyIn("skillOverrides", bare) && !toWrite.some((x) => x.id === bare)) toWrite.push({ kind: "skill", id: bare, to: "inherit" } as SkillChange);
  }
  const merged = withSkillSettings(text, toWrite);
  if (!merged.ok) return bad(`${t.display}: ${merged.error}`, merged.error.startsWith("not valid JSON") ? 422 : 400);
  if (merged.changed.length === 0) return { ok: true, file: t.display, changed: [] };
  try {
    if (lvl === "global") {
      if (!existsSync(dirname(t.abs))) return bad(`${displayPath(dirname(t.abs))} does not exist, so no settings file is made there.`, 422);
      writeTextAtomicKeepMode(t.abs, merged.text);
    } else {
      mkdirSync(dirname(t.abs), { recursive: true });
      writeTextAtomicKeepMode(t.abs, merged.text, worktree);
    }
  } catch (e) {
    return bad(`${t.display} was not written: ${(e as Error).message}`, 422);
  }
  resetPluginListCache(); // the plugin list's on/off default was read before this write
  console.log(`[skills] wrote ${t.display} (${merged.changed.length} change${merged.changed.length === 1 ? "" : "s"})`);
  if (input.logFile) {
    const kindOf = new Map(list.map((c) => [String(c.id), c.kind]));
    const before = (doc.totals.skillChars ?? 0) + (doc.totals.pluginChars ?? 0);
    const saved = savingsOf(doc.rows, list).chars;
    appendSkillSwitchLog(input.logFile, {
      ts: new Date().toISOString(),
      repoId: input.repoId ?? null,
      level: lvl,
      file: t.display,
      changes: merged.changed.map((c) => ({ kind: kindOf.get(c.id) === "plugin" ? "plugin" : "skill", id: c.id, from: c.from, to: c.to })),
      listingCharsBefore: before,
      listingCharsAfter: before - saved,
    });
  }
  const out: WriteOutcome = { ok: true, file: t.display, changed: merged.changed };
  if (lvl === "repo-local" && worktree) {
    let ignored = true;
    try { execFileSync("git", ["check-ignore", "-q", "--", ".claude/settings.local.json"], { cwd: worktree, stdio: "ignore" }); } catch { ignored = false; }
    out.gitignored = ignored;
    if (!ignored) out.ignoredNote = ".claude/settings.local.json is not in this repo's .gitignore, so git would show it as a new file. Nothing here edits .gitignore.";
  }
  return out;
}
