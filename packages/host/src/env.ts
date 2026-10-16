/**
 * The daemon's root directory, and the `.env` files loaded into `process.env`
 * — BEFORE any other host module is evaluated.
 *
 * `main.ts` imports this FIRST. An ES import list is evaluated, depth-first, in
 * order, before the importing module's body runs; so when the loop below sat in
 * `main.ts`'s body, every module that reads an env knob at import
 * (`sessions/knobs.ts`, `intents/contract.ts`'s `TICK_MS`, `backends/claude.ts`'s
 * `CLAUDE_BIN` knob, …) had already read `process.env` — and a knob set only in
 * one of these files was silently ignored by all of them. Being the first
 * import is what makes the files mean what `.env.example` says they mean.
 *
 * Precedence, highest first: the process's own environment (the shell, launchd,
 * every e2e script's pinned env), then the per-user config dir (where set-secret
 * host scope writes, and hot-reloads into `process.env`), then the repo `.env`,
 * then `<STATE_DIR>/.env`. `envfiles.ts`
 * says why a later file wins and why `process.loadEnvFile` could not do it.
 * Keep this module's own imports to ones that read nothing from the
 * environment at import.
 *
 * Before any file is read, `branddirs.ts` moves the daemon's own directories
 * from a legacy name to the current one (config, data, `<ROOT>/<state dir>`),
 * leaving a symlink at the old name — and then moves `<ROOT>/<state dir>` OUT of
 * the code root into the global state dir (`STATE_DIR`: `<PREFIX>STATE_DIR` →
 * `$XDG_STATE_HOME/<name>` → `~/.local/state/<name>`). Both run in the daemon
 * only. `bindHostStateDir` then makes `hostStateDir(ROOT)` answer that dir, so
 * every store that opens after this module finds its data there.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { logTag, makeEnvReader, nodeMeetsMin, nodeTooOldSentence, resolveEnv } from "@waterplane/shared";
import { homedir } from "node:os";
import { bindHostStateDir, liveStateDir, migrateHostDirs, migrateStateDir, pendingStateMove, realRootFs, resolveRoot, resolveStateDir, stateMoveRefusedSentence } from "./branddirs.js";
import { readChosenRoot } from "./rootchoice.js";
import { loadEnvFiles } from "./envfiles.js";
import { hostSecretEnvPath } from "./secrets.js";

// Before anything below reads import.meta.dirname (undefined before Node 20.11,
// and `resolve(undefined)` throws) or envfiles.ts calls util.parseEnv (20.12):
// one sentence instead of a TypeError. The bar is shared's NODE_MIN.
if (!nodeMeetsMin(process.versions.node)) {
  console.error(`${logTag} ${nodeTooOldSentence(process.versions.node)}`);
  process.exit(1);
}

/** The files that may name the root and the state dir, into a scratch copy. The
 *  root decides the state dir, which decides the first `.env`, so that one file
 *  can never name either; the other two can, and until 2026-10-07 neither was
 *  read before `resolveRoot` ran: a `<PREFIX>ROOT` set only in the repo `.env`
 *  (what `.env.example` tells you to do) was silently ignored for the root. */
const bootEnv: NodeJS.ProcessEnv = { ...process.env };
loadHostEnv(null, bootEnv);

// The knob, then the folder chosen in the phone's dialog (`rootchoice.ts`), then the guess.
const rootPick = resolveRoot(bootEnv, homedir(), realRootFs, readChosenRoot());
/** The code root: `<PREFIX>ROOT`, else the folder chosen on the phone, else the first usual code folder that exists, else `~/dev` (`branddirs.ts`' `resolveRoot`). */
export const ROOT = rootPick.root;
/** True when nobody named or chose the root and it was derived (found or assumed) — the doctor says so. */
export const ROOT_DEFAULTED = rootPick.defaulted;
/** How the root came about: `named` (the knob), `chosen` (`rootchoice.ts`), `found` (an existing usual folder) or `fallback` (`~/dev`, which may not exist). */
export const ROOT_PICKED = rootPick.picked;

/**
 * True when this process IS the daemon — its entry script is this package's
 * `main` — rather than a test or a tool that imports a host module (dozens of
 * modules import this one for `env()`). Realpath'd, so the npm `bin` symlink
 * counts; `.ts` under `tsx` and `.js` under node both match.
 */
function isDaemonEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let real: string;
  try { real = realpathSync(entry); } catch { real = resolve(entry); }
  const here = (() => { try { return realpathSync(import.meta.dirname); } catch { return import.meta.dirname; } })();
  return dirname(real) === here && /^main\.(js|ts|mjs)$/.test(basename(real));
}

/** THE `.env` load, in its one precedence order — for real below, and into a
 *  scratch copy by the boot-move guard, which needs the port before the state
 *  dir (and so the first file) is final, and by the root pick above, which runs
 *  before there is a state dir at all (`null`: that file is skipped). A function
 *  so the order exists once. */
function loadHostEnv(stateDir: string | null, target: NodeJS.ProcessEnv, origins?: Map<string, string>): void {
  loadEnvFiles([
    ...(stateDir === null ? [] : [join(stateDir, ".env")]),
    resolve(import.meta.dirname, "../../../.env"),
    hostSecretEnvPath(),
  ], target, origins);
}

const realOr = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * `host:port` of a running host whose root is ours, or null. The port is the
 * one this boot will use, read through the same `.env` files the boot is about
 * to load (into a scratch copy — nothing is loaded for real yet). 800 ms: a
 * host that is up answers its health route in single milliseconds.
 */
async function otherDaemonFor(root: string, oldState: string): Promise<string | null> {
  const peek: NodeJS.ProcessEnv = { ...process.env };
  try { loadHostEnv(oldState, peek); } catch { /* the default port */ }
  const port = Number(resolveEnv(peek, "PORT").value) || 8770;
  const at = `127.0.0.1:${port}`;
  try {
    const r = await fetch(`http://${at}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = (await r.json()) as { root?: unknown; protocol?: unknown };
    if (typeof body?.protocol !== "number") return null; // not one of ours
    return typeof body.root !== "string" || realOr(body.root) === realOr(root) ? at : null;
  } catch { return null; }
}

// Rename legacy dirs to the current brand's names, once, before anything reads
// them — ONLY in the daemon itself, never because a unit test imported a module
// that reads a knob (that would move a person's real `~/.config` and `<ROOT>`
// state under a test run). Never throws; what it did is one line each.
// `--doctor` is the daemon's entry too, but a preflight only looks: it reads
// wherever the state is now and reports a pending move instead of making it.
// `doctor --json` owns stdout: the report is one JSON document there, so every
// other line the boot prints (this module's own notes included) goes to stderr.
if (process.argv.includes("--doctor") && process.argv.includes("--json")) {
  console.log = console.info = console.error;
}
const statePick = resolveStateDir(bootEnv);
let stateDir: string;
if (isDaemonEntry()) {
  for (const r of migrateHostDirs(ROOT)) if (r.note) console.log(`${logTag} ${r.note}`);
  if (process.argv.includes("--doctor")) stateDir = liveStateDir(ROOT, statePick.dir);
  else {
    // A move is about to happen: refuse it while ANOTHER daemon for this root is
    // still answering (a host from before the restart, an older build). It
    // writes the old path; one write between the rename and the pointer would
    // recreate a real dir there and split the state in two. Asked over the
    // daemon's own health route, top-level await, only when there is a move to
    // make — a boot with nothing to move never waits on the network.
    const from = pendingStateMove(ROOT, statePick.dir);
    const other = from ? await otherDaemonFor(ROOT, from) : null;
    if (other) {
      console.warn(`${logTag} ${stateMoveRefusedSentence(from!, statePick.dir, other)}`);
      stateDir = from!;
    } else {
      const m = migrateStateDir(ROOT, statePick.dir);
      if (m.note) (m.action === "failed" || (m.action === "merged" && m.kept?.length) ? console.warn : console.log)(`${logTag} ${m.note}`);
      stateDir = m.dir;
    }
  }
} else {
  stateDir = liveStateDir(ROOT, statePick.dir);
}
/** The daemon's global state dir, outside the code root — `hostStateDir(ROOT)` answers it. */
export const STATE_DIR = stateDir;
bindHostStateDir(ROOT, STATE_DIR);

// Load secrets/config from gitignored .env files. Lets the Gemini key live on
// disk (e.g. synced from Bitwarden) instead of the shell. Lowest precedence
// first: <STATE_DIR>/.env → repo .env → the fixed per-user config dir, so what
// the phone set last is what runs after a restart. The old under-root
// `<ROOT>/<state dir>/.env` is not read: after the move it is a symlink to this
// same file; when both dirs held a `.env` the merge kept the new one and left
// the old one beside a MOVED.txt; and when the move failed STATE_DIR IS the old dir.
const envOrigins = new Map<string, string>();
loadHostEnv(STATE_DIR, process.env, envOrigins);

/**
 * The knob readers: `env("PORT")` reads the current-brand name, then each
 * legacy name (`shared/envresolve.ts`), and warns ONCE per legacy name it had
 * to fall back to, naming the `.env` file that set it when one did. Read at
 * CALL time from `process.env`, so a hot-reloaded secret is seen. Existing
 * `process.env.<LEGACY>_X` reads keep working; the rename moves them here.
 */
export const { env, envStr, envBool, envInt } = makeEnvReader(
  process.env,
  (text) => console.warn(text),
  (name) => envOrigins.get(name),
);
