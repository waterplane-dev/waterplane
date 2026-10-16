// Claude Code PostToolUse hook (Edit|Write|MultiEdit), wired in .claude/settings.json.
//
// Runs the cheap repo guards that read the file just edited — and only those,
// only the `edit` tier of `guards.mjs` (file readers, no build, ~0.2–0.4 s each)
// — so the session that breaks a rule hears about it in the same turn instead
// of at a push that may be hours and several commits later.
//
// The working tree is SHARED: several sessions edit this checkout at once. A
// guard runs over the whole tree, so it also fails on somebody else's
// half-finished edit, and an agent told "your edit broke this" would go and
// "fix" a file another session is in the middle of writing. So a failure only
// BLOCKS (exit 2, stderr to the agent) when it names this edit — its path, its
// skill, or a module the new text names (`blames`). Anything else is said
// once per session as context, as somebody else's, never as an order.
//
// Off for a session: the EDIT_GUARDS knob (`envName("EDIT_GUARDS")`, in .env.example) set to 0.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { blames, editTokens, formatFailure, guardsFor, headroom, runGuards } from "./guards.mjs";

function readStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
}

/** Notes already given this session, so a standing failure is said once, not on every edit. */
function seenStore(sessionId) {
  const dir = join(tmpdir(), "repo-edit-guards");
  const path = join(dir, `${String(sessionId || "nosession").replace(/[^\w.-]/g, "_")}.json`);
  let seen = new Set();
  try { seen = new Set(JSON.parse(readFileSync(path, "utf8"))); } catch { /* first note */ }
  return {
    fresh: (key) => !seen.has(key),
    add: (key) => seen.add(key),
    save: () => { try { mkdirSync(dir, { recursive: true }); writeFileSync(path, JSON.stringify([...seen])); } catch { /* best effort */ } },
  };
}

/**
 * The off switch's name, read from BRAND like every knob (scripts/autoupdate.mjs's
 * pattern). Without a built shared/dist there is no name to read, and the
 * guards stay ON: an unreadable off switch is not a reason to skip a check.
 */
async function offKnob() {
  try {
    const root = new URL("../../", import.meta.url).pathname;
    return (await import(pathToFileURL(join(root, "packages/shared/dist/brand.js")).href)).envName("EDIT_GUARDS");
  } catch { return null; }
}

function main(knob) {
  if (knob && process.env[knob] === "0") return 0;
  const input = readStdin();
  const file = input?.tool_input?.file_path;
  if (!file) return 0;
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const rel = relative(root, file).split("\\").join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return 0;

  const tests = guardsFor([rel], "edit", root);
  const room = headroom(root, rel);
  if (!tests.length && !room) return 0;

  const failures = tests.length ? runGuards(tests, root) : [];
  const tokens = editTokens(rel, input.tool_input);
  const mine = failures.filter((f) => blames(f, tokens));
  const others = failures.filter((f) => !blames(f, tokens));

  if (mine.length) {
    process.stderr.write(
      `A repo guard fails on your edit to ${rel}. Fix it now — the pre-push gate runs the same check.\n\n` +
      mine.map(formatFailure).join("\n\n") + "\n",
    );
    return 2;
  }

  const seen = seenStore(input.session_id);
  const notes = [];
  for (const f of others) {
    const key = `other:${f.file}:${f.name}`;
    if (!seen.fresh(key)) continue;
    seen.add(key);
    notes.push(f);
  }
  const lines = [];
  if (notes.length) {
    lines.push(
      `A repo guard is failing, but not on anything your edit to ${rel} names — probably another ` +
      `session's unfinished work in this shared tree. Do not fix it unless it is yours; mention it if it ` +
      `blocks your commit.\n\n` + notes.map(formatFailure).join("\n\n"),
    );
  }
  if (room && seen.fresh(`room:${rel}:${room.bucket}`)) {
    seen.add(`room:${rel}:${room.bucket}`);
    lines.push(room.text);
  }
  seen.save();
  if (lines.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: lines.join("\n\n") },
    }));
  }
  return 0;
}

process.exitCode = main(await offKnob());
