/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/assess-architecture.md (host). */
import type { AssessProgress, AssessStep, AssessStepKind } from "@waterplane/shared";
import { ASSESS_OUT_FILE, ASSESS_PLAN_FILE } from "@waterplane/shared";
import { env } from "../env.js";

// ── The run ──────────────────────────────────────────────────────────────────

// ── Watching one run happen ──────────────────────────────────────────────────
//
// The contract is still a FILE, and this changes none of it: the stream is READ
// and never believed. Nothing below produces a verdict, a count that any
// decision reads, or a reason to stop waiting — it produces the sentences a
// person watching a twenty-minute run needs in order to tell it apart from a
// run that died in its first second. The screen used to say one sentence for
// all twenty minutes, on a phone, with no terminal to glance at.
//
// Which is why every failure here is SILENCE rather than a wrong reading: a
// line that will not parse contributes no step, an unknown tool keeps its own
// name, and a stream that never arrives leaves `progress` absent — which is
// exactly the screen this feature was added to.

/** How many steps the tail keeps. It is persisted with the settled run, so this
 *  is also how much of a finished run's history survives it. */
export const ASSESS_TAIL_MAX = 24;
/** One step's `detail`, and the run's own last words. */
const STEP_DETAIL_MAX = 160;
const SAY_MAX = 400;

/**
 * How often a reading is pushed to whoever is watching.
 *
 * Every push is a broadcast to every connected phone, and a repo read fires
 * tool calls far faster than anybody can read them. 1.5 s is slow enough to
 * cost nothing and fast enough that the list visibly moves, which is the whole
 * signal. The final reading is pushed regardless of this clock.
 */
export const assessProgressMs = (): number => Math.max(250, Number(env("ASSESS_PROGRESS_MS")) || 1500);
/** The knob at import. `runAssessment` asks `assessProgressMs()` per run instead: the knob used to be
 *  read when `assess.js` loaded, and a test re-imports that one file to change it — now that the read
 *  sits in a slice the barrel's re-import would not reach it. Same value in a daemon, whose env never moves. */
export const ASSESS_PROGRESS_MS = assessProgressMs();

/**
 * Tool name → the SHAPE of the step, for the icon the phone draws.
 *
 * A name this table does not know is `tool` and keeps its own label: a later
 * CLI gaining a tool must make the list less specific, never undrawable.
 */
const TOOL_KIND: Readonly<Record<string, AssessStepKind>> = {
  Read: "read", NotebookRead: "read",
  Grep: "search", Glob: "search",
  Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit",
  Bash: "run", BashOutput: "run", KillShell: "run",
  Task: "task", Agent: "task",
  WebFetch: "web", WebSearch: "web",
};

/** The empty reading a run starts from. */
export function assessProgressInit(now: number = Date.now()): AssessProgress {
  return { tail: [], steps: 0, tools: 0, at: now };
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** A path the CLI named, said the way the repo says it. An absolute path inside
 *  the worktree is the same file as its relative one and four times as wide on
 *  a phone; anything else is left exactly as it was written. */
function relPath(p: string, cwd: string): string {
  if (p === cwd) return ".";
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
}

/** What one tool call was ABOUT, out of its own arguments. Absent when the call
 *  named nothing a sentence could use — never a guess, and never the whole
 *  argument object. */
function toolDetail(name: string, input: unknown, cwd: string): string | undefined {
  const a = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof a[k] === "string" && a[k] ? String(a[k]) : undefined);
  const path = str("file_path") ?? str("notebook_path") ?? str("path");
  switch (name) {
    case "Grep": {
      const pat = str("pattern");
      const where = str("path") ?? str("glob");
      if (!pat) return where ? relPath(where, cwd) : undefined;
      return where ? `${pat} in ${relPath(where, cwd)}` : pat;
    }
    case "Glob": return str("pattern") ?? (path ? relPath(path, cwd) : undefined);
    case "Bash": return str("description") ?? str("command");
    case "Task": case "Agent": return str("description") ?? str("subagent_type");
    case "WebFetch": return str("url");
    case "WebSearch": return str("query");
    default: {
      if (path) return relPath(path, cwd);
      // An unknown tool still usually names one thing; the first string
      // argument is that thing far more often than not, and when it is not,
      // the label alone is still true.
      for (const v of Object.values(a)) if (typeof v === "string" && v.trim()) return v;
      return undefined;
    }
  }
}

function pushStep(p: AssessProgress, step: AssessStep): AssessProgress {
  const tail = [...p.tail, step].slice(-ASSESS_TAIL_MAX);
  return { ...p, tail, steps: p.steps + 1, tools: p.tools + (step.kind === "say" ? 0 : 1), at: step.at };
}

/**
 * Fold one line of `--output-format stream-json` into the reading.
 *
 * Pure, and the only thing in this file that reads the CLI's event vocabulary —
 * which is why it is exported and pinned by `assessprogress.test.mjs` rather
 * than described. A line it cannot use returns the reading it was given,
 * UNCHANGED and identical, so the caller's "has anything happened?" is an
 * object comparison and a run that prints noise pushes nothing.
 */
export function foldAssessEvent(prev: AssessProgress, line: string, cwd: string, now: number): AssessProgress {
  const raw = line.trim();
  if (!raw || raw[0] !== "{") return prev;
  let ev: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return prev;
    ev = parsed as Record<string, unknown>;
  } catch { return prev; }

  if (ev.type === "system" && ev.subtype === "init") {
    const model = typeof ev.model === "string" ? ev.model : undefined;
    return model && model !== prev.model ? { ...prev, model, at: now } : prev;
  }
  if (ev.type !== "assistant") return prev;

  const msg = (ev.message && typeof ev.message === "object" ? ev.message : {}) as Record<string, unknown>;
  const content = Array.isArray(msg.content) ? msg.content : [];
  let next = prev;
  const model = typeof msg.model === "string" ? msg.model : undefined;
  if (model && model !== next.model) next = { ...next, model };
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const b = part as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      const say = clip(b.text, SAY_MAX);
      next = pushStep({ ...next, say }, { at: now, kind: "say", label: "said", detail: say });
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      const name = b.name;
      const detail = toolDetail(name, b.input, cwd);
      next = pushStep(next, { at: now, kind: TOOL_KIND[name] ?? "tool", label: name, detail: detail ? clip(detail, STEP_DETAIL_MAX) : undefined });
      // The two files the whole contract is about. Read off the CALL rather
      // than off the disk: the disk is asked once, at the end, and "is it
      // writing its answer yet" is a question about now.
      const wrote = typeof detail === "string" ? detail : "";
      if (name === "Write" || name === "Edit" || name === "MultiEdit") {
        if (wrote.endsWith(ASSESS_OUT_FILE)) next = { ...next, wroteOut: true };
        if (wrote.endsWith(ASSESS_PLAN_FILE)) next = { ...next, wrotePlan: true };
      }
    }
  }
  return next === prev ? prev : { ...next, at: now };
}