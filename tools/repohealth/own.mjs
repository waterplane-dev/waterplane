/**
 * A repo's OWN readings — the numbers a repo declares about itself, beside the
 * ones this engine takes in every repo.
 *
 * ── Two kinds of reading, kept apart ───────────────────────────────────────
 *
 * Everything else under `tools/repohealth/` is waterplane's: the same method in
 * every tree, pre-registered in `constants.mjs`, pinned by `fixture.json`, and
 * the only inputs the health index reads, so one repo's index can be put beside
 * another's. A repo also knows things about itself no generic metric can — in
 * waterplane, how many of the CLI screen readers have no proof on the
 * installed `claude`. Those are declared by the repo, in a COMMITTED
 * file, and they ride in the series row under `own`, a key no metric and no
 * reading in `readings.mjs` ever reads. The index reads TWO things from it: a
 * reading the repo marked as a gate, and a reading that declares a target
 * (both below). They change no definition, so `PREREG_VERSION` and the pack
 * hash do not move; a score that counts one marks the week a coverage gap.
 *
 * ── The declaration ────────────────────────────────────────────────────────
 *
 * `<shared dir>/health.json` (`OWN_FILE`) — the committed half of the per-repo
 * config, beside `builds.json`; the state dir is gitignored and holds this
 * desktop's own things. Read out of the COMMIT (`git.readFileAt`), never off the
 * disk: only a declaration somebody committed runs.
 *
 *   { "readings": [ { "key": "screenNoProof", "name": "…", "means": "…",
 *                     "better": "lower", "unit": "signals",
 *                     "run": ["node", "tools/screenfixtures.mjs", "--reading"] } ] }
 *
 * A reading may be marked a GATE — a line the repo itself calls critical:
 *
 *   "gate": { "fails": "below", "at": 60 }
 *
 * `fails` is the side of `at` that fails (`below`: value < at; `above`:
 * value > at; the line itself passes), and it must be the WORSE side of the
 * reading's own `better` — a gate failing when the reading improves is a typo,
 * refused like any other bad field (the reading is then not run, and the
 * index counts the gate as UNKNOWN, never as passed). The engine only carries
 * the declaration into the row; judging it is the index's
 * (`shared/healthindex/coverage.ts`): a failing gate caps the headline, a gate
 * whose reading is absent is unknown.
 *
 * A reading may also declare a TARGET — the repo's own good line:
 *
 *   "target": 5
 *
 * A number above 0 (the score is a ratio to it), read in the reading's own
 * `better` direction. With one, the reading joins the health score like one
 * of waterplane's entries (`shared/healthindex/own.ts`: scored against the
 * target, in the mean, the worst-entry cap and coverage); without one it stays
 * out of the score. A bad target is refused like any other bad field — the
 * reading is not run and the index counts it UNKNOWN, never scored.
 *
 * A reading that reads THIS DESKTOP rather than the commit (machine state)
 * says `"backfill": false`: `own-backfill` then leaves it absent at older
 * commits instead of running it there (`ownbackfill.mjs`).
 *
 * The same file's `central` object re-tunes waterplane's OWN readings — one
 * disabled, or measured by the repo's command instead — and is `central.mjs`'s
 * business: it changes what the index reads, which nothing here ever does.
 *
 * ── Running one ────────────────────────────────────────────────────────────
 *
 * `run` is an argv array, spawned with NO shell, cwd the measured root, a
 * minimal environment (no daemon secrets ride along), a timeout and an output
 * cap. Its stdout must be ONE JSON number or `{ "value": n }`. Anything else —
 * a non-zero exit, a timeout, a missing program, text, NaN, two numbers — makes
 * that reading ABSENT with the reason, never 0: a zero is a reading, and a
 * reading nobody took must not look like one.
 *
 * Only at HEAD on `update`: it calls this for the newest first-parent commit
 * only, so a series backfill runs nothing per old commit and checks nothing
 * out. History starts the day a reading is first declared — unless a person
 * asks for more: `own-backfill` (`ownbackfill.mjs`) reads older commits back in
 * a scratch worktree, on request only, each with the declaration THAT commit
 * held. The command runs in the CHECKOUT as it
 * stands — that is what HEAD's row means for a reading of this kind, and the
 * one caveat a repo's author should know: an uncommitted edit is in it.
 *
 * ── Trust ──────────────────────────────────────────────────────────────────
 *
 * This runs code the repo supplies. It is the same trust a repo's own
 * `tools/repohealth.mjs` already gets from the daemon (that one replaces this
 * whole engine), and the same a repo's build commands get — said plainly in
 * `packages/host/src/repohealth.ts` beside the containment note. Nothing in the
 * argv comes from anywhere but that committed file, and cwd is the root the
 * engine was pointed at, never a path the file names.
 */
import { spawnSync } from "node:child_process";
import { BRAND } from "@waterplane/shared";

/** Where a repo declares its own readings, repo-relative. Committed. */
export const OWN_FILE = `${BRAND.sharedDirName}/health.json`;
/** At most this many readings are RUN; the rest are listed absent with the reason. */
export const OWN_MAX = 12;
/** One reading's wall-clock budget. The daemon kills the whole engine at its own cap. */
export const OWN_TIMEOUT_MS = 30_000;
/** Bytes of stdout a reading may print before it is cut and refused. */
export const OWN_MAX_OUTPUT = 64 * 1024;
/** The declaration file itself, past which it is refused whole. */
const OWN_MAX_FILE = 64 * 1024;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/** The environment a reading runs with: enough to find and start a program,
 *  nothing the daemon holds for itself (tokens, keys, `WATERPLANE_*`). */
const ENV_KEEP = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TZ", "XDG_STATE_HOME", "XDG_CONFIG_HOME"];
export function readingEnv(src = process.env) {
  const out = {};
  for (const k of ENV_KEEP) if (typeof src[k] === "string") out[k] = src[k];
  return out;
}

/**
 * The declaration's text, checked. `{ refused }` for a file that is not the
 * shape at all; otherwise `{ readings, problems }`, where an entry with a
 * usable key but a bad field stays a reading — absent, with the reason — and an
 * entry with no usable key is a sentence in `problems`, since nothing could
 * carry its series.
 */
export function parseDeclaration(text) {
  if (typeof text !== "string") return { refused: `${OWN_FILE} could not be read` };
  if (text.length > OWN_MAX_FILE) return { refused: `${OWN_FILE} is over ${OWN_MAX_FILE / 1024} KB` };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { refused: `${OWN_FILE} is not JSON (${err.message})` };
  }
  // A file that only re-tunes the CENTRAL readings (`central.mjs`) declares
  // none of its own, and that is not a broken declaration.
  if (doc && typeof doc === "object" && !Array.isArray(doc) && doc.readings === undefined && doc.central !== undefined) {
    return { readings: [], problems: [], none: true };
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.readings)) {
    return { refused: `${OWN_FILE} has no "readings" list` };
  }
  const readings = [];
  const problems = [];
  const scratch = scratchOf(doc.scratch, problems);
  // Entries dropped for want of a key that had asked for a gate: the index counts each as an UNKNOWN gate (`unreadGates`).
  let unreadGates = 0;
  // …and those that had asked for a target: each one UNKNOWN in the score's coverage (`unreadTargets`).
  let unreadTargets = 0;
  const seen = new Set();
  doc.readings.forEach((raw, i) => {
    const e = raw && typeof raw === "object" ? raw : {};
    if (typeof e.key !== "string" || !KEY_RE.test(e.key)) {
      problems.push(`entry ${i + 1} has no usable "key" (a letter, then up to 39 letters, digits, - or _)`);
      if (e.gate !== undefined) unreadGates++;
      if (e.target !== undefined) unreadTargets++;
      return;
    }
    if (seen.has(e.key)) {
      problems.push(`"${e.key}" is declared twice; only the first is read`);
      return;
    }
    seen.add(e.key);
    const why = [];
    if (!isStr(e.name) || e.name.length > 80) why.push(`"name" must be a phrase under 80 characters`);
    if (!isStr(e.means) || e.means.length > 400) why.push(`"means" must be one sentence under 400 characters`);
    if (e.better !== "lower" && e.better !== "higher") why.push(`"better" must be "lower" or "higher"`);
    if (e.unit !== undefined && (typeof e.unit !== "string" || e.unit.length > 16)) why.push(`"unit" must be a short word`);
    const gate = gateOf(e.gate, e.better);
    if (gate && gate.invalid) why.push(gate.invalid);
    // A reading of THIS DESKTOP (`"backfill": false`) cannot count in a score that reads the same on every
    // desktop (R-metrics-069): its target is refused with a sentence, the reading still runs untargeted.
    const thisDesktop = e.backfill === false;
    let target = targetOf(e.target, e.better);
    if (thisDesktop && e.target !== undefined && !(target && typeof target === "object")) {
      problems.push(`"${e.key}" has a target and "backfill": false: its target is refused, because a reading of this desktop cannot count in a score that reads the same on every desktop; the reading runs without it`);
      target = undefined;
    }
    if (target && typeof target === "object") why.push(target.invalid);
    const runOk = validArgv(e.run);
    if (!runOk) why.push(`"run" must be an argv list of 1–32 non-empty strings`);
    readings.push({
      key: e.key,
      name: isStr(e.name) ? e.name.trim().slice(0, 80) : e.key,
      means: isStr(e.means) ? e.means.trim().slice(0, 400) : "",
      better: e.better === "lower" || e.better === "higher" ? e.better : null,
      unit: typeof e.unit === "string" ? e.unit.slice(0, 16) : "",
      run: runOk ? e.run.slice() : null,
      ...(gate ? { gate } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(thisDesktop ? { backfill: false } : {}),
      ...(why.length ? { invalid: `not run — ${why.join("; ")}` } : {}),
    });
  });
  return { readings, problems, unreadGates, ...(unreadTargets ? { unreadTargets } : {}), ...(scratch ? { scratch } : {}) };
}

/** A usable argv: 1–32 non-empty strings, each short and free of NUL. One rule for a reading's `run` and a scratch `prepare`. */
export const validArgv = (a) => Array.isArray(a) && a.length >= 1 && a.length <= 32
  && a.every((x) => typeof x === "string" && x.length > 0 && x.length <= 512 && !x.includes("\0"));

/**
 * The declaration's `scratch` object — what the read-back's scratch copy needs
 * for the commands to run there (`ownbackfill.mjs`): `linkNodeModules` and a
 * `prepare` argv. Undefined where none is declared or it is unusable; an
 * unusable one is a sentence in `problems` and turns the scratch features OFF,
 * never the readings. Never used at HEAD in the live checkout.
 */
export function scratchOf(raw, problems) {
  if (raw === undefined) return undefined;
  const off = (why) => { problems.push(`"scratch" ${why}: the read-back's scratch copy gets neither a node_modules link nor a prepare step`); return undefined; };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return off(`must be { "linkNodeModules": true, "prepare": [argv] }`);
  const known = new Set(["linkNodeModules", "prepare"]);
  const extra = Object.keys(raw).find((k) => !known.has(k));
  if (extra) return off(`has an unknown field "${extra}"`);
  if (raw.linkNodeModules !== undefined && typeof raw.linkNodeModules !== "boolean") return off(`"linkNodeModules" must be true or false`);
  if (raw.prepare !== undefined && !validArgv(raw.prepare)) return off(`"prepare" must be an argv list of 1–32 non-empty strings`);
  const out = {
    ...(raw.linkNodeModules === true ? { linkNodeModules: true } : {}),
    ...(raw.prepare !== undefined ? { prepare: raw.prepare.slice() } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/**
 * A reading's `gate`, checked: undefined where none is declared,
 * `{ fails, at }` where it is usable, `{ invalid }` where it is not. An
 * invalid gate is still CARRIED (as `{ invalid }`), so the index can say a gate
 * was meant and could not be read rather than silently dropping it.
 */
export function gateOf(g, better) {
  if (g === undefined) return undefined;
  const bad = (why) => ({ invalid: `"gate" ${why}` });
  if (!g || typeof g !== "object" || Array.isArray(g)) return bad(`must be { "fails": "below" | "above", "at": <number> }`);
  if (g.fails !== "below" && g.fails !== "above") return bad(`"fails" must be "below" or "above"`);
  if (typeof g.at !== "number" || !Number.isFinite(g.at)) return bad(`"at" must be a number`);
  const worse = better === "higher" ? "below" : better === "lower" ? "above" : null;
  if (worse && g.fails !== worse) return bad(`fails "${g.fails}" but "better" is "${better}": a gate fails on the worse side`);
  return { fails: g.fails, at: g.at };
}

/**
 * A reading's `target`, checked: undefined where none is declared, the number
 * where it is usable, `{ invalid }` where it is not. An invalid target is still
 * CARRIED (as `{ invalid }`), so the index counts a reading the repo meant to
 * score as unknown with the reason rather than dropping it from the score.
 * Above 0, because the score is a ratio to it (`100 · min(1, target / value)`
 * for lower, `100 · min(1, value / target)` for higher); a reading whose
 * `better` is itself bad is refused on that field already.
 */
export function targetOf(t, better) {
  if (t === undefined) return undefined;
  if (typeof t !== "number" || !Number.isFinite(t)) return { invalid: `"target" must be a number` };
  if (!(t > 0)) return { invalid: `"target" must be above 0: the score is a ratio to it` };
  if (better !== "lower" && better !== "higher") return { invalid: `"target" needs "better" to say which side of it is good` };
  return t;
}

/**
 * What a reading printed, as a value — or the reason it is not one.
 * One JSON number, or an object whose `value` is one. Finite only.
 */
export function parseReadingOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return { value: null, reason: "printed nothing" };
  const quote = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { value: null, reason: `printed ${JSON.stringify(quote)}, not one JSON number or {"value": n}` };
  }
  if (v && typeof v === "object" && !Array.isArray(v)) v = v.value;
  if (typeof v === "number" && Number.isFinite(v)) return { value: v };
  return { value: null, reason: `printed ${JSON.stringify(quote)}, not one JSON number or {"value": n}` };
}

/** The last non-empty line of stderr, short — the sentence a failing tool most often ends on. */
function lastLine(s) {
  const lines = String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const l = lines.at(-1) ?? "";
  return l.length > 200 ? `${l.slice(0, 197)}…` : l;
}

/**
 * Run ONE declared reading in `root`. Always returns `{ value }` or
 * `{ value: null, reason }`; never throws.
 */
export function runReading(root, decl, opts = {}) {
  if (decl.invalid) return { value: null, reason: decl.invalid };
  const got = execArgv(root, decl.run, opts);
  return got.reason ? { value: null, reason: got.reason } : parseReadingOutput(got.stdout);
}

/**
 * Spawn one argv in `root` — no shell, the minimal env, a timeout, its own
 * process group killed with it. `{ stdout }` on exit 0, else `{ reason }`: the
 * sentence a failing command leaves. Never throws. A reading's output goes to
 * `parseReadingOutput`; a scratch `prepare` only needs the verdict.
 */
export function execArgv(root, run, { timeoutMs = OWN_TIMEOUT_MS, env = readingEnv(), spawn = spawnSync, maxBuffer = OWN_MAX_OUTPUT } = {}) {
  const [cmd, ...args] = run;
  let res;
  try {
    res = spawn(cmd, args, {
      cwd: root,
      env,
      shell: false,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      // Its own process group, so a timeout can take a wrapper's worker with it.
      detached: process.platform !== "win32",
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { reason: `could not start ${cmd}: ${err.message}` };
  }
  const code = res.error?.code;
  const timedOut = code === "ETIMEDOUT" || (res.signal === "SIGKILL" && res.status === null && !code);
  // The timeout SIGKILLs only the direct child; the group is the wrapper's workers too.
  if (timedOut && process.platform !== "win32" && Number.isInteger(res.pid) && res.pid > 1) {
    try { process.kill(-res.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (timedOut) return { reason: `did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped` };
  if (code === "ENOBUFS") return { reason: `printed more than ${Math.round(maxBuffer / 1024)} KB` };
  if (code === "ENOENT") return { reason: `could not start ${cmd}: no such program on PATH` };
  if (res.error) return { reason: `could not start ${cmd}: ${res.error.message}` };
  if (res.status !== 0) {
    const said = lastLine(res.stderr);
    return { reason: `exited ${res.status ?? res.signal}${said ? `: ${said}` : ""}` };
  }
  return { stdout: res.stdout };
}

/**
 * The row's `own` field for the commit at `sha`, or undefined when that commit
 * declares nothing (the row then carries no `own` key at all).
 *
 * @param {string} root
 * @param {string} sha
 * @param {{ readFileAt: (root: string, sha: string, path: string) => string | null }} git
 */
export function measureOwn(root, sha, git, opts = {}) {
  const text = git.readFileAt(root, sha, OWN_FILE);
  if (text === null) return undefined;
  const decl = parseDeclaration(text);
  if (decl.none) return undefined;
  if (decl.refused) return { file: OWN_FILE, refused: decl.refused };
  // `opts.skip(d)` → a sentence: that reading is not run here, ABSENT with it
  // (`ownbackfill.mjs`: a command this desktop did not approve, or one the repo
  // marks HEAD-only). Absent hook = run every reading.
  const readings = decl.readings.map((d, i) => {
    const skipped = i < OWN_MAX && typeof opts.skip === "function" ? opts.skip(d) : null;
    const got = skipped
      ? { value: null, reason: skipped }
      : i < OWN_MAX
        ? runReading(root, d, opts)
        : { value: null, reason: `not run — past the first ${OWN_MAX} readings a repo may declare` };
    return {
      key: d.key,
      name: d.name,
      means: d.means,
      better: d.better,
      unit: d.unit,
      ...(d.gate ? { gate: d.gate } : {}),
      ...(d.target !== undefined ? { target: d.target } : {}),
      ...(d.backfill === false ? { backfill: false } : {}),
      value: got.value,
      ...(got.reason ? { reason: got.reason } : {}),
    };
  });
  return {
    file: OWN_FILE, readings,
    ...(decl.problems.length ? { problems: decl.problems } : {}),
    ...(decl.unreadGates ? { unreadGates: decl.unreadGates } : {}),
    ...(decl.unreadTargets ? { unreadTargets: decl.unreadTargets } : {}),
  };
}

/**
 * The row's `own` where the repo's commands are NOT approved (`--no-own`):
 * nothing is run, but the committed declaration is still read, so the index
 * learns that gates and targets exist and counts each UNKNOWN (never a silent
 * pass, never a score). `gates` lists every reading the index counts — one
 * with a gate, a target or both.
 * `notRun` marks the row so approval re-measures it (`update`). Undefined where
 * the commit declares nothing.
 */
export function notRunOwn(root, sha, git) {
  const text = git.readFileAt(root, sha, OWN_FILE);
  if (text === null) return undefined;
  const decl = parseDeclaration(text);
  if (decl.none) return undefined;
  if (decl.refused) return { file: OWN_FILE, refused: decl.refused };
  const notRun = "not run — this desktop has not approved the repo's committed commands";
  const gates = decl.readings.filter((d) => d.gate || d.target !== undefined).map((d) => ({
    key: d.key, name: d.name, unit: d.unit, better: d.better,
    ...(d.gate ? { gate: d.gate } : {}),
    ...(d.target !== undefined ? { target: d.target } : {}),
    value: null, reason: notRun,
  }));
  return {
    file: OWN_FILE, notRun, gates,
    ...(decl.unreadGates ? { unreadGates: decl.unreadGates } : {}),
    ...(decl.unreadTargets ? { unreadTargets: decl.unreadTargets } : {}),
  };
}

/** Whether the commit at `sha` declares own readings — for `plot`, which runs nothing. */
export function declaresOwn(root, sha, git) {
  const text = git.readFileAt(root, sha, OWN_FILE);
  return text !== null && !parseDeclaration(text).none;
}
