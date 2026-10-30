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
 * file, and they ride in the series row under `own`, a key no metric, no
 * reading in `readings.mjs` and no index entry ever reads. They change no
 * definition, so `PREREG_VERSION` and the pack hash do not move.
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
 * Only at HEAD: `update` calls this for the newest first-parent commit only, so
 * a backfill runs nothing per old commit and checks nothing out. History starts
 * the day a reading is first declared. The command runs in the CHECKOUT as it
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
export const OWN_MAX = 8;
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
  const seen = new Set();
  doc.readings.forEach((raw, i) => {
    const e = raw && typeof raw === "object" ? raw : {};
    if (typeof e.key !== "string" || !KEY_RE.test(e.key)) {
      problems.push(`entry ${i + 1} has no usable "key" (a letter, then up to 39 letters, digits, - or _)`);
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
    const runOk = Array.isArray(e.run) && e.run.length >= 1 && e.run.length <= 32
      && e.run.every((a) => typeof a === "string" && a.length > 0 && a.length <= 512 && !a.includes("\0"));
    if (!runOk) why.push(`"run" must be an argv list of 1–32 non-empty strings`);
    readings.push({
      key: e.key,
      name: isStr(e.name) ? e.name.trim().slice(0, 80) : e.key,
      means: isStr(e.means) ? e.means.trim().slice(0, 400) : "",
      better: e.better === "lower" || e.better === "higher" ? e.better : null,
      unit: typeof e.unit === "string" ? e.unit.slice(0, 16) : "",
      run: runOk ? e.run.slice() : null,
      ...(why.length ? { invalid: `not run — ${why.join("; ")}` } : {}),
    });
  });
  return { readings, problems };
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
export function runReading(root, decl, { timeoutMs = OWN_TIMEOUT_MS, env = readingEnv(), spawn = spawnSync } = {}) {
  if (decl.invalid) return { value: null, reason: decl.invalid };
  const [cmd, ...args] = decl.run;
  let res;
  try {
    res = spawn(cmd, args, {
      cwd: root,
      env,
      shell: false,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: OWN_MAX_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { value: null, reason: `could not start ${cmd}: ${err.message}` };
  }
  const code = res.error?.code;
  if (code === "ETIMEDOUT" || (res.signal === "SIGKILL" && res.status === null && !code)) {
    return { value: null, reason: `did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped` };
  }
  if (code === "ENOBUFS") return { value: null, reason: `printed more than ${OWN_MAX_OUTPUT / 1024} KB` };
  if (code === "ENOENT") return { value: null, reason: `could not start ${cmd}: no such program on PATH` };
  if (res.error) return { value: null, reason: `could not start ${cmd}: ${res.error.message}` };
  if (res.status !== 0) {
    const said = lastLine(res.stderr);
    return { value: null, reason: `exited ${res.status ?? res.signal}${said ? `: ${said}` : ""}` };
  }
  return parseReadingOutput(res.stdout);
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
  const readings = decl.readings.map((d, i) => {
    const got = i < OWN_MAX
      ? runReading(root, d, opts)
      : { value: null, reason: `not run — past the first ${OWN_MAX} readings a repo may declare` };
    return {
      key: d.key,
      name: d.name,
      means: d.means,
      better: d.better,
      unit: d.unit,
      value: got.value,
      ...(got.reason ? { reason: got.reason } : {}),
    };
  });
  return { file: OWN_FILE, readings, ...(decl.problems.length ? { problems: decl.problems } : {}) };
}

/** Whether the commit at `sha` declares own readings — for `plot`, which runs nothing. */
export function declaresOwn(root, sha, git) {
  const text = git.readFileAt(root, sha, OWN_FILE);
  return text !== null && !parseDeclaration(text).none;
}
