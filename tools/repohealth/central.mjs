/**
 * A repo's say over waterplane's CENTRAL readings — disable one, or measure it
 * with the repo's own command — without forking the whole engine.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A repo that disagreed with one of the five readings the health index reads
 * had one way out: ship its own `tools/repohealth.mjs`, which replaces this
 * engine whole (the daemon runs it in preference to the bundled one). That
 * freezes the repo on the day it forked — every later improvement to every
 * other reading passes it by. `central` lets a repo change ONE reading and
 * keep the rest of the engine as it moves.
 *
 * ── The declaration ────────────────────────────────────────────────────────
 *
 * In the same committed `<shared dir>/health.json` as the repo's own readings
 * (`own.mjs`), keyed by the index entry it changes:
 *
 *   { "central": {
 *       "context": { "disable": true, "why": "CLAUDE.md is generated here" },
 *       "size":    { "run": ["node", "tools/p95.mjs"], "why": "…", "means": "…" } } }
 *
 * `why` is REQUIRED: a change to a shared definition that cannot say why is
 * ignored, with a sentence in `problems`, exactly as an own reading with a bad
 * field is listed absent with its reason. An unknown key, a `run` that is not
 * an argv list, both verbs at once, or neither, are ignored the same way.
 *
 * ── What each verb does ────────────────────────────────────────────────────
 *
 * - **disable** — the reading is still measured (it costs nothing, and a
 *   later re-enable then has history), but it leaves the index: the weekly
 *   link is the mean over the entries that remain, and the tile says
 *   *disabled* with the repo's `why`. Read per commit, from that commit's own
 *   declaration — a disable needs nothing run, so a backfill can honour it.
 * - **override** — the repo's command is run INSTEAD, with `own.mjs`'s
 *   sandbox (argv, no shell, cwd the root, minimal env, 30 s, 64 KB, one JSON
 *   number or `{value}`), and its number takes that entry's slot in the
 *   index. It must print the number in the central reading's own unit and
 *   direction (`UNITS` below — lower is healthier, always). The central value
 *   is still measured beside it.
 *
 * ── What history an override has ──────────────────────────────────────────
 *
 * HEAD ONLY, as for own readings: `update` runs the command for the newest
 * first-parent commit and nothing older, because running repo code against
 * an old commit would need a checkout of it, which this engine never makes
 * in a shared working tree. So **an override has no history before it was
 * first measured**: older rows — including rows a recut backfills under a
 * declaration that already named it — carry the central value, and the first
 * row that ran the command starts the override's series. A recut therefore
 * restarts it at one point.
 *
 * ── Why a change here never reads as a health move ─────────────────────────
 *
 * Every row that holds a `central` field carries `fp`, a fingerprint of what
 * was APPLIED on that row: the disabled keys, and the overridden keys with
 * their argv — the overrides that RAN, not the ones declared. Two weeks with
 * different fingerprints are compared under two definitions, so
 * `shared/healthindex.ts` CARRIES that link (a gap, as for a prereg change).
 * A repo disabling a reading, adding an override, or changing its command is
 * one carried week, never a jump. `fp` is "" where nothing is applied, which
 * is also what a row without the field compares as.
 *
 * ── Trust ──────────────────────────────────────────────────────────────────
 *
 * An override runs code the repo supplies — the same trust as an own reading
 * and as a repo's own engine, said once in `packages/host/src/repohealth.ts`.
 * The argv comes from the committed file only, read out of the commit.
 */
import { createHash } from "node:crypto";
import { OWN_FILE, runReading } from "./own.mjs";

/**
 * The entries a repo may disable or override — the health index's five, with
 * the unit an override must print. A share is a fraction 0–1, never a percent.
 */
export const UNITS = Object.freeze({
  size: "p95 lines per source file",
  retouch: "the re-touch rate, a fraction 0–1",
  hatches: "unexplained escape hatches per 1,000 lines",
  context: "always-on context characters (CLAUDE.md + skill descriptions)",
  untested: "the share of source modules no test reaches, a fraction 0–1",
});
export const CENTRAL_KEYS = Object.freeze(Object.keys(UNITS));
const FRACTIONS = new Set(["retouch", "untested"]);

const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * The `central` object of a parsed health.json, checked. Returns
 * `{ entries, problems }` — `entries[key]` is `{kind: "disable", why}` or
 * `{kind: "override", why, means, run}` — or null when the file has no
 * `central` key at all.
 */
export function parseCentral(doc) {
  if (!doc || typeof doc !== "object" || doc.central === undefined) return null;
  const problems = [];
  const entries = {};
  const c = doc.central;
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    return { entries, problems: [`"central" must be an object keyed by reading (${CENTRAL_KEYS.join(", ")}); ignored`] };
  }
  for (const [key, raw] of Object.entries(c)) {
    if (!CENTRAL_KEYS.includes(key)) {
      problems.push(`"${key}" is not a central reading (${CENTRAL_KEYS.join(", ")}); ignored`);
      continue;
    }
    const e = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    if (!isStr(e.why) || e.why.length > 400) {
      problems.push(`"${key}" has no "why" (one sentence under 400 characters); ignored — a change to a central reading must say why`);
      continue;
    }
    const why = e.why.trim();
    const hasRun = e.run !== undefined;
    if (e.disable === true && hasRun) {
      problems.push(`"${key}" both disables and overrides; ignored — say one`);
      continue;
    }
    if (e.disable === true) {
      entries[key] = { kind: "disable", why };
      continue;
    }
    if (!hasRun) {
      problems.push(`"${key}" neither disables ("disable": true) nor overrides ("run": [...]); ignored`);
      continue;
    }
    const runOk = Array.isArray(e.run) && e.run.length >= 1 && e.run.length <= 32
      && e.run.every((a) => typeof a === "string" && a.length > 0 && a.length <= 512 && !a.includes("\0"));
    if (!runOk) {
      problems.push(`"${key}".run must be an argv list of 1–32 non-empty strings; ignored`);
      continue;
    }
    entries[key] = {
      kind: "override",
      why,
      means: isStr(e.means) ? e.means.trim().slice(0, 400) : "",
      run: e.run.slice(),
    };
  }
  return { entries, problems };
}

/**
 * The fingerprint of what was APPLIED on a row: "" when nothing, else 12 hex
 * of sha1 over the canonical list. Not a security boundary — an identity tag
 * for "the same definition as last week".
 */
export function centralFingerprint(disabled, override) {
  const d = Object.keys(disabled ?? {}).sort();
  const o = Object.keys(override ?? {}).sort().map((k) => [k, override[k].run]);
  if (!d.length && !o.length) return "";
  return createHash("sha1").update(JSON.stringify({ d, o })).digest("hex").slice(0, 12);
}

/** An override's printed number, held to its entry's unit. */
function checkValue(key, got) {
  if (got.value === null) return got;
  if (got.value < 0) return { value: null, reason: `printed ${got.value}; ${UNITS[key]} is never negative` };
  if (FRACTIONS.has(key) && got.value > 1) {
    return { value: null, reason: `printed ${got.value}; ${UNITS[key]} — a percent is not accepted` };
  }
  return got;
}

/**
 * The row's `central` field, or undefined when the declaration in force has
 * no `central` key (the row then carries no field at all, and compares as
 * fingerprint ""). `text` is the health.json in force at this commit, or null.
 * `atHead` decides whether overrides RUN (see the header); off HEAD they are
 * listed in `notRun` and the central value stands.
 */
export function measureCentral(root, text, { atHead, run = runReading, opts = {} } = {}) {
  if (typeof text !== "string") return undefined;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined; // `own.mjs` already says the file is not JSON, on the same row.
  }
  const parsed = parseCentral(doc);
  if (!parsed) return undefined;
  const disabled = {};
  const override = {};
  const notRun = [];
  for (const [key, e] of Object.entries(parsed.entries).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (e.kind === "disable") {
      disabled[key] = { why: e.why };
      continue;
    }
    if (!atHead) {
      notRun.push(key);
      continue;
    }
    const got = checkValue(key, run(root, { run: e.run }, opts));
    override[key] = {
      why: e.why,
      means: e.means,
      run: e.run,
      value: got.value,
      ...(got.reason ? { reason: got.reason } : {}),
    };
  }
  return {
    file: OWN_FILE,
    fp: centralFingerprint(disabled, override),
    ...(Object.keys(disabled).length ? { disabled } : {}),
    ...(Object.keys(override).length ? { override } : {}),
    ...(notRun.length ? { notRun } : {}),
    ...(parsed.problems.length ? { problems: parsed.problems } : {}),
  };
}

/**
 * The health.json text in force at each commit, by first-parent index —
 * read only at the commits that TOUCHED it (one `cat-file` each), and carried
 * forward between them. `git.readFileAt` is the reader `own.mjs` uses.
 */
export function declarationsByIndex(root, history, git) {
  const commits = history.commits ?? [];
  const out = new Array(commits.length).fill(null);
  let text = null;
  let read = false;
  for (let i = 0; i < commits.length; i++) {
    const touched = (history.touches?.get(commits[i].sha) ?? commits[i].filesTouched ?? []).includes(OWN_FILE);
    if (touched || !read) {
      // The first commit is read whether or not it touched the file, so a
      // history that starts mid-way (a shallow clone) still knows its state.
      text = git.readFileAt(root, commits[i].sha, OWN_FILE);
      read = true;
    }
    out[i] = text;
  }
  return out;
}
