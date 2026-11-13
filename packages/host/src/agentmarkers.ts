/**
 * What changed in the instructions an agent reads, as markers for the agent
 * readings' time axis (`@waterplane/shared` `AgentMarker`; the readings and the
 * markers the points show are shared `agentseries`).
 *
 * Every marker is a FACT git recorded: a commit touching the repo's instruction
 * paths, a commit touching the global ones (`<config dir>/CLAUDE.md`, `skills/`,
 * `agents/`, followed through symlinks into whatever repo holds them), or an
 * `instr/*` tag a person put on the change they mean. A global file that lives
 * in no git repo gives NO markers and a sentence saying so — never a guess from
 * mtimes, which move on every checkout and copy. The skills-switch save log adds `switch` markers
 * (`readSwitchLog`, `switchMarkers`).
 */
import { open } from "node:fs/promises";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { collapseMarkers, type AgentMarker } from "@waterplane/shared";
import { claudeConfigDir } from "./claudeconfig.js";
import { execFileP } from "./proc.js";

/** The repo's own instruction paths, as git pathspecs. */
export const REPO_INSTRUCTION_PATHS = ["CLAUDE.md", "AGENTS.md", ".claude/skills", ".claude/agents", ".claude/settings*.json"];
/** The global ones, relative to the CLI's config directory. */
export const GLOBAL_INSTRUCTION_PATHS = ["CLAUDE.md", "skills", "agents"];
export const TAG_PREFIX = "instr/";

const GIT_TIMEOUT_MS = 10_000;
const LABEL_MAX = 120;
const FILES_IN_DETAIL = 5;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-c", "core.quotepath=off", ...args], {
    cwd, maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, // English stderr: toplevelOf tells "not a git repository" by its words
  });
  return stdout;
}

/** Commits since `sinceMs` touching `paths`, one marker each (kind `instructions`). */
async function commitMarkers(top: string, paths: string[], sinceMs: number, extra: { repo?: string; scope?: string }): Promise<AgentMarker[]> {
  const out = await git(top, ["log", `--since=${new Date(sinceMs).toISOString()}`, "--format=%x1e%H%x1f%at%x1f%s", "--name-only", "--", ...paths]);
  const markers: AgentMarker[] = [];
  for (const rec of out.split("\x1e")) {
    const [head, ...rest] = rec.split("\n");
    const [sha, at, subject] = (head ?? "").split("\x1f");
    const t = Number(at) * 1000;
    if (!sha || !Number.isFinite(t) || t < sinceMs) continue;
    const files = rest.map((l) => l.trim()).filter(Boolean);
    const shown = files.slice(0, FILES_IN_DETAIL).join(", ") + (files.length > FILES_IN_DETAIL ? `, and ${files.length - FILES_IN_DETAIL} more` : "");
    markers.push({
      t, kind: "instructions",
      label: (subject ?? "").trim().slice(0, LABEL_MAX) || sha.slice(0, 7),
      detail: [extra.scope, shown].filter(Boolean).join(": "),
      ...(extra.repo !== undefined ? { repo: extra.repo } : {}),
    });
  }
  return markers;
}

/** `instr/*` tags dated since `sinceMs` (tagger date, or the commit's for a lightweight tag). */
async function tagMarkers(top: string, sinceMs: number, repo: string | undefined): Promise<AgentMarker[]> {
  const out = await git(top, ["for-each-ref", "--format=%(refname:short)%1f%(creatordate:unix)%1f%(objectname:short)", `refs/tags/${TAG_PREFIX}`]);
  const markers: AgentMarker[] = [];
  for (const line of out.split("\n")) {
    const [name, at, sha] = line.split("\x1f");
    const t = Number(at) * 1000;
    if (!name?.startsWith(TAG_PREFIX) || !Number.isFinite(t) || t < sinceMs) continue;
    markers.push({ t, kind: "tag", label: name.slice(TAG_PREFIX.length), ...(sha ? { detail: sha } : {}), ...(repo !== undefined ? { repo } : {}) });
  }
  return markers;
}

/** Where a path is versioned: its work tree, "none" (git said it is no repository), or "unreadable" (git failed some other way). */
type Toplevel = { top: string } | "none" | "unreadable";

/** The git work tree holding `real` (a resolved path). Only git's own "not a git repository" is `none`; a timeout or "dubious ownership" is `unreadable`. */
async function toplevelOf(real: string): Promise<Toplevel> {
  let dir = real;
  try { if (!statSync(real).isDirectory()) dir = dirname(real); } catch { return "unreadable"; }
  try {
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    return top ? { top: realpathSync(top) } : "none";
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    return /not a git repository/i.test(`${typeof e.stderr === "string" ? e.stderr : ""}\n${e.message ?? ""}`) ? "none" : "unreadable";
  }
}

export interface InstructionMarkers {
  markers: AgentMarker[];
  /** One sentence per source that gave no markers because it could not be read — never a guess in its place. */
  absent: string[];
}

/**
 * Instruction markers since `sinceMs`: the repo's instruction commits and
 * `instr/*` tags, and the global instruction files' commits wherever their
 * resolved path is versioned. Same-kind markers of one day are collapsed.
 */
export async function instructionMarkers(
  repoDir: string,
  sinceMs: number,
  opts: { configDir?: string; repo?: string } = {},
): Promise<InstructionMarkers> {
  const repo = opts.repo ?? basename(repoDir);
  const markers: AgentMarker[] = [];
  const absent: string[] = [];

  try {
    const top = await toplevelOf(realpathSync(repoDir));
    if (top === "none") absent.push(`${repo} is not a git repository, so its instruction changes are not known.`);
    else if (top === "unreadable") absent.push(`git could not be read in ${repo}, so its instruction changes are not known.`);
    else {
      markers.push(...await commitMarkers(repoDir, REPO_INSTRUCTION_PATHS, sinceMs, { repo }));
      markers.push(...await tagMarkers(repoDir, sinceMs, repo));
    }
  } catch (err) {
    absent.push(`git log in ${repo} failed: ${(err as Error).message.split("\n")[0]}`);
  }

  const cfg = opts.configDir ?? claudeConfigDir();
  const byTop = new Map<string, { rels: string[]; shown: string[] }>();
  const add = (top: string, real: string, shown: string): void => {
    const e = byTop.get(top) ?? { rels: [], shown: [] };
    e.rels.push(relative(top, real) || ".");
    e.shown.push(shown);
    byTop.set(top, e);
  };
  const noRepo = (given: string): string => `${given} is in no git repository, so its changes are not known.`;
  const unread = (given: string): string => `${given} could not be read by git, so its changes are not known.`;
  for (const p of GLOBAL_INSTRUCTION_PATHS) {
    const given = join(cfg, p);
    let real: string;
    try { real = realpathSync(given); } catch { continue; } // not there: nothing to mark
    const top = await toplevelOf(real);
    if (typeof top === "object") { add(top.top, real, given); continue; }
    // A plain `skills/` or `agents/` directory of per-entry symlinks (each into whatever repo holds
    // that entry): the directory itself is no work tree, its entries are, grouped by repo.
    let entries: string[] = [];
    if (top === "none" && p !== "CLAUDE.md") {
      try { if (statSync(real).isDirectory()) entries = readdirSync(real).filter((n) => !n.startsWith(".")); } catch { /* the sentence below */ }
    }
    let versioned = 0, unversioned = 0, unreadable = 0;
    for (const name of entries) {
      let er: string;
      try { er = realpathSync(join(real, name)); } catch { unreadable++; continue; }
      const t = await toplevelOf(er);
      if (typeof t === "object") { add(t.top, er, join(given, name)); versioned++; }
      else if (t === "none") unversioned++;
      else unreadable++;
    }
    if (versioned === 0) { absent.push(top === "none" && unreadable === 0 ? noRepo(given) : unread(given)); continue; }
    if (unversioned > 0) absent.push(`${unversioned} of ${entries.length} entries in ${given} are in no git repository, so their changes are not known.`);
    if (unreadable > 0) absent.push(`${unreadable} of ${entries.length} entries in ${given} could not be read by git, so their changes are not known.`);
  }
  const seen = new Set(markers.map((m) => `${m.t}|${m.label}`));
  for (const [top, { rels, shown }] of byTop) {
    try {
      for (const m of await commitMarkers(top, rels, sinceMs, { scope: "global" })) {
        if (seen.has(`${m.t}|${m.label}`)) continue; // the repo IS the global one
        markers.push(m);
      }
    } catch (err) {
      absent.push(`git log for ${shown.join(", ")} failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return { markers: collapseMarkers(markers), absent };
}

/** One line of `<hostStateDir>/skillswitch-log.jsonl` (docs/analysis/skills-switch/PLAN.md, "The save record"). */
export interface SwitchLogEntry {
  /** ISO time of the save. */
  ts: string;
  /** The repo the switch was saved for; null = the host-wide (user level) route, which applies to every repo. */
  repoId: string | null;
  level?: string;
  file?: string;
  changes: { kind: string; id: string; from: string; to: string }[];
  listingCharsBefore?: number;
  /** An ESTIMATE the skills screen made (before minus its own saving), never a measurement. */
  listingCharsAfter?: number;
}

/** Newest bytes of the log read: the log is append-only and the marker window is recent. */
const SWITCH_LOG_TAIL = 2 * 1024 * 1024;

/** The log's entries; a missing or unreadable file is none, a malformed line is skipped. */
export async function readSwitchLog(file: string): Promise<SwitchLogEntry[]> {
  let text: string;
  try {
    const fh = await open(file, "r");
    try {
      const size = (await fh.stat()).size;
      const start = Math.max(0, size - SWITCH_LOG_TAIL);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1); // the cut line is partial
    } finally { await fh.close(); }
  } catch { return []; }
  const out: SwitchLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SwitchLogEntry;
      if (e && typeof e.ts === "string" && Array.isArray(e.changes) && (e.repoId === null || typeof e.repoId === "string")) out.push(e);
    } catch { /* a torn line */ }
  }
  return out;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
const sign = (n: number): string => (n < 0 ? "\u2212" : "+") + Math.abs(Math.round(n)).toLocaleString("en-US");

/**
 * `switch` markers from the log's entries: those for `opts.repoId` plus the host-wide ones (labelled
 * "all repos"). The label says what was switched; the detail lists ids from to to and, when the entry
 * has both figures, the skills screen's own ESTIMATE of the listing change, worded as one.
 */
export function switchMarkers(
  entries: readonly SwitchLogEntry[],
  sinceMs: number,
  opts: { repoId?: string; repo?: string } = {},
): AgentMarker[] {
  const out: AgentMarker[] = [];
  for (const e of entries) {
    if (!e || typeof e.ts !== "string" || !Array.isArray(e.changes) || e.changes.length === 0) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    const global = e.repoId === null;
    if (!global && e.repoId !== opts.repoId) continue;
    const groups = new Map<string, number>();
    for (const c of e.changes) groups.set(`${c.kind}|${c.to}`, (groups.get(`${c.kind}|${c.to}`) ?? 0) + 1);
    const parts = [...groups].map(([k, n]) => { const [kind, to] = k.split("|"); return `${plural(n, String(kind))} ${to}`; });
    const label = `Skills switch${global ? " (all repos)" : ""}: ${parts.join(", ")}`.slice(0, LABEL_MAX);
    const ids = e.changes.slice(0, FILES_IN_DETAIL).map((c) => `${c.kind} ${c.id} ${c.from} \u2192 ${c.to}`).join("; ")
      + (e.changes.length > FILES_IN_DETAIL ? `; and ${e.changes.length - FILES_IN_DETAIL} more` : "");
    const est = typeof e.listingCharsBefore === "number" && typeof e.listingCharsAfter === "number"
      ? `. Skill listing about ${sign(e.listingCharsAfter - e.listingCharsBefore)} chars (estimated by the skills screen, not measured)` : "";
    out.push({ t, kind: "switch", label, detail: ids + est, ...(!global && opts.repo !== undefined ? { repo: opts.repo } : {}) });
  }
  return collapseMarkers(out);
}
