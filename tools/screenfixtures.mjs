#!/usr/bin/env node
/**
 * Screen-fixture freshness: for every signal in the CLI health catalog, how
 * many REAL captures of the CLI's output the tests run that reader against,
 * which CLI version the newest one came from, and how far that is behind the
 * `claude` installed here.
 *
 * Why this and not the test count: the heuristics read a binary that changes
 * underneath them, and a test that passes on a hand-typed box proves only that
 * the regex matches what somebody believed the CLI draws. `clihealth.ts` finds
 * the drift on the live host AFTER a phone has sat blocked; this finds it
 * before, as "the newest screen this detector was tested on is N releases old".
 *
 * Which fixture feeds which signal is declared in
 * `packages/host/test/fixtures/signals.json`, not guessed from file names. A
 * capture's version comes from that entry's `cli`, else from the
 * `Claude Code vX.Y.Z` banner in the file, else it is unknown — and an unknown
 * version is shown as unknown, never as current.
 *
 *   node tools/screenfixtures.mjs            # table
 *   node tools/screenfixtures.mjs --json     # rows as JSON
 *   node tools/screenfixtures.mjs --npm      # count published releases (asks the npm registry)
 *   node tools/screenfixtures.mjs --cli 2.1.301 --health path/to/clihealth.json
 *   node tools/screenfixtures.mjs --reading  # ONE number: signals with NO proof on the installed CLI
 *   node tools/screenfixtures.mjs --unproven # ONE number: signals with NO matching real capture, any version
 *   node tools/screenfixtures.mjs --debt     # ONE number: host captures the repo has no fixture for yet
 *   node tools/screenfixtures.mjs --captures <dir>  # another host capture dir (default <state>/clifixtures)
 *
 * `--reading` is this repo's own repo-health reading (`screenNoProof` in
 * `.waterplane-shared/health.json`): it prints one JSON number and nothing else
 * on stdout. A signal has PROOF on the installed CLI when any of three holds:
 * (a) a repo fixture from that version (`current`); (b) a host capture of it
 * in `<state>/clifixtures/<installed>/`, which `clifixtures.ts` writes only the
 * first time the signal WORKS on that version; (c) the live clihealth record
 * for that version has a `lastGoodAt`. The reading counts the signals with
 * none, so lower is better and the number names real gaps.
 *
 * It used to count (a) alone, and that measured harvest cadence, not drift:
 * every CLI release (several a week) dropped it to 0 until someone ran
 * `tools/harvestfixtures.mjs --write` and committed — on v2.1.314 it read 0 of
 * 10 while the host held 2.1.314 captures for five signals and the table below
 * printed "last good 3m ago" beside them. Captures the repo does not have yet
 * are a chore, not a gap; they are not counted here but by `--debt`.
 *
 * `--debt` is that chore as its own figure (`harvestDebt`): how many host
 * captures, of any version, have no fixture in `signals.json` at the path
 * `tools/harvestfixtures.mjs --write` would give them — including any it would
 * refuse (a leak, no reader): those need a person too, and that tool says
 * which. Not filtered here because its reader check needs `packages/host/dist`
 * and a reading should not need a host build. Machine state too, and
 * the same absence rule: no manifest or no capture dir prints nothing, exits 1.
 *
 * The figure depends on THIS machine's installed CLI and its host state, not
 * on the commit, so the same sha reads differently on two days. That is why it
 * is a repo's own reading (`tools/repohealth/own.mjs`): run at HEAD only, never
 * back-filled for an old commit, never part of the health index. Where it
 * cannot be counted honestly — the installed version is unknown, the catalog
 * is not built, the manifest or this desktop's clihealth.json is unreadable,
 * or the capture dir cannot be listed — it prints nothing and exits 1 with the
 * reason, so the series records an absence rather than a number that claims
 * signals unproved which nobody here could look at.
 *
 * `--unproven` is the second reading (`screenUnproven`): how many signals have
 * never been shown to read a real screen at all — zero `match` captures of any
 * CLI version (a guard proves the reader declines, not that it reads). The
 * same absence rule: no catalog, no manifest or an empty catalog prints
 * nothing and exits 1, never a 0 nobody counted.
 *
 * A readout: it exits 0 and refuses nothing (`--reading` aside, below). Needs `npm run build:shared`
 * (the catalog is read from `packages/shared/dist`, the one list of signals).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listSamples, fixturePath } from "./harvestfixtures.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "packages/host/test/fixtures");
const MANIFEST = join(FIXTURES, "signals.json");
const CATALOG = join(ROOT, "packages/shared/dist/clihealth/healthcatalog.js");
const NPM_PACKAGE = "@anthropic-ai/claude-code";

// ── Versions ────────────────────────────────────────────────────────────

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

export function parseVersion(s) {
  const m = VERSION_RE.exec(String(s ?? ""));
  return m ? m.slice(1, 4).map(Number) : null;
}

export function cmpVersion(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The version a capture came from, off its welcome banner; null without one. */
export function bannerVersion(text) {
  const m = /Claude Code v(\d+\.\d+\.\d+)/.exec(text);
  return m ? m[1] : null;
}

/**
 * How far `older` is behind `newer`. With the published release list it is a
 * count of releases; without one it is the patch-number distance, and only
 * inside one major.minor — across a minor bump there is no honest number
 * offline, so it is null.
 */
export function versionGap(older, newer, releases) {
  if (!parseVersion(older) || !parseVersion(newer)) return null;
  if (cmpVersion(older, newer) >= 0) return { n: 0, unit: "releases" };
  if (releases) {
    const n = releases.filter((v) => parseVersion(v) && cmpVersion(v, older) > 0 && cmpVersion(v, newer) <= 0).length;
    return { n, unit: "releases" };
  }
  const [a, b] = [parseVersion(older), parseVersion(newer)];
  if (a[0] !== b[0] || a[1] !== b[1]) return null;
  return { n: b[2] - a[2], unit: "patch numbers" };
}

// ── The manifest ────────────────────────────────────────────────────────

function expand(pattern) {
  if (!pattern.includes("*")) return [pattern];
  const dir = dirname(pattern);
  const re = new RegExp("^" + basename(pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
  const abs = join(FIXTURES, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((f) => re.test(f)).sort().map((f) => join(dir, f));
}

/** One signal's fixtures, deduplicated by path; a path listed as both `match`
 *  and `guard` counts once, as `match`. Entries naming a missing file are kept
 *  aside so the readout can say so instead of counting them. */
export function resolveEntries(entries, read = (p) => readFileSync(join(FIXTURES, p), "utf8")) {
  const byPath = new Map();
  const missing = [];
  for (const e of entries ?? []) {
    const paths = expand(e.path);
    if (paths.length === 0) missing.push(e.path);
    for (const p of paths) {
      let text;
      try { text = read(p); } catch { missing.push(p); continue; }
      const prev = byPath.get(p);
      const role = prev?.role === "match" || e.role === "match" ? "match" : (e.role ?? "guard");
      byPath.set(p, { path: p, role, cli: e.cli ?? prev?.cli ?? bannerVersion(text) });
    }
  }
  return { fixtures: [...byPath.values()], missing };
}

// ── One row per signal ──────────────────────────────────────────────────

/**
 * The ids the host captured on `installed` — proof (b). `samples` is
 * `listSamples`' list; another version's capture proves nothing here.
 */
export function capturedOn(samples, installed) {
  return new Set(installed ? samples.filter((s) => s.version === installed).map((s) => s.id) : []);
}

/** Which of the three proofs a signal has on `installed`; empty without a version. */
function proofOf(id, state, live, installed, captured) {
  if (!installed) return [];
  const proof = [];
  if (state === "current") proof.push("fixture");
  if (captured?.has(id)) proof.push("capture");
  if (live?.lastGoodAt && parseVersion(live.version) && cmpVersion(live.version, installed) === 0) proof.push("live");
  return proof;
}

export function rowFor(spec, entries, live, installed, releases, captured) {
  const { fixtures, missing } = resolveEntries(entries);
  const dated = fixtures.filter((f) => parseVersion(f.cli));
  const newest = dated.length ? dated.map((f) => f.cli).sort(cmpVersion).at(-1) : null;
  const gap = newest && installed ? versionGap(newest, installed, releases) : null;
  let state;
  if (fixtures.length === 0) state = "none";
  else if (!newest) state = "undated";
  else if (!installed) state = "unknown";
  else if (gap?.n === 0) state = "current";
  else state = "behind";
  return {
    id: spec.id,
    name: spec.name,
    fixtures: fixtures.length,
    match: fixtures.filter((f) => f.role === "match").length,
    guard: fixtures.filter((f) => f.role !== "match").length,
    undated: fixtures.length - dated.length,
    newest,
    gap,
    state,
    proof: proofOf(spec.id, state, live, installed, captured),
    missing,
    live: live
      ? { version: live.version ?? null, misses: live.misses ?? 0, lastGoodAt: live.lastGoodAt ?? null, lastMissAt: live.lastMissAt ?? null }
      : null,
  };
}

// ── Inputs off this machine ─────────────────────────────────────────────

/** The host's state dir by the host's own precedence (`shared/statedir.ts`),
 *  so the name is read from BRAND and never spelled here. */
async function stateDir() {
  const { stateDirPick } = await import(pathToFileURL(join(ROOT, "packages/shared/dist/statedir.js")).href);
  return stateDirPick(process.env, homedir()).dir;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function installedCli() {
  try {
    return parseVersion(execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }))?.join(".") ?? null;
  } catch { return null; }
}

function npmReleases() {
  try {
    const out = execFileSync("npm", ["view", NPM_PACKAGE, "versions", "--json"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
    const list = JSON.parse(out);
    return Array.isArray(list) ? list : null;
  } catch { return null; }
}

/**
 * The `--reading` figure: how many rows have no proof on the installed CLI,
 * or null with the reason when that count cannot be told from zero.
 */
export function noProofCount(rows, installed) {
  if (!installed) return { value: null, reason: "the installed claude version is unknown, so nothing can be proof on it" };
  return { value: rows.filter((r) => r.proof.length === 0).length };
}

/**
 * The `--unproven` figure: signals with no `match` capture of any version, or
 * null with the reason when the inputs that count them are missing — an absent
 * manifest would otherwise read as "all ten unproven", an empty catalog as 0.
 */
export function unprovenCount(rows, manifest) {
  if (!manifest || typeof manifest !== "object") return { value: null, reason: "packages/host/test/fixtures/signals.json is missing or unreadable" };
  if (!rows?.length) return { value: null, reason: "the signal catalog lists no signals" };
  return { value: rows.filter((r) => r.match === 0).length };
}

/**
 * The `--debt` figure: host captures (`listSamples`' list) whose fixture path
 * the manifest does not list, or null with the reason when there is no
 * manifest or no capture dir to compare — either would read as a false 0.
 */
export function harvestDebt(samples, manifest, dirExists) {
  if (!manifest?.signals || typeof manifest.signals !== "object") return { value: null, reason: "packages/host/test/fixtures/signals.json is missing or unreadable" };
  if (!dirExists) return { value: null, reason: "there is no host capture dir on this desktop" };
  const listed = new Set(Object.values(manifest.signals).flat().map((e) => e?.path));
  return { value: samples.filter((x) => !listed.has(fixturePath(x))).length };
}

// ── Output ──────────────────────────────────────────────────────────────

function ago(ms, now) {
  if (!ms) return null;
  const h = (now - ms) / 3600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function sentence(r, now) {
  const fx = r.fixtures === 0
    ? "no real capture"
    : `${r.fixtures} real capture${r.fixtures === 1 ? "" : "s"} (${r.match} match, ${r.guard} guard${r.undated ? `, ${r.undated} undated` : ""})`;
  let age;
  if (r.state === "none") age = "";
  else if (r.state === "undated") age = "; no capture says which CLI drew it";
  else if (r.state === "unknown") age = `; newest from v${r.newest}, installed version unknown`;
  else if (r.state === "current") age = `; newest from v${r.newest}, the installed version`;
  else age = `; newest from v${r.newest}, ${r.gap ? `${r.gap.n} ${r.gap.unit} behind` : "behind by an amount not countable offline (try --npm)"}`;
  const proof = r.proof.length ? ` Proof on this CLI: ${r.proof.join(", ")}.` : " No proof on this CLI.";
  let live = "";
  if (r.live) {
    const bits = [];
    if (r.live.misses) bits.push(`${r.live.misses} miss${r.live.misses === 1 ? "" : "es"}${r.live.lastMissAt ? `, last ${ago(r.live.lastMissAt, now)}` : ""}`);
    if (r.live.lastGoodAt) bits.push(`last good ${ago(r.live.lastGoodAt, now)}`);
    if (bits.length) live = ` Live: ${bits.join(", ")}.`;
  }
  const miss = r.missing.length ? ` Manifest names ${r.missing.length} file(s) that are not there: ${r.missing.join(", ")}.` : "";
  return `${fx}${age}.${proof}${live}${miss}`;
}

async function main(argv) {
  const flag = (f) => argv.includes(f);
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

  if (!existsSync(CATALOG)) {
    console.error("screenfixtures: no built signal catalog at packages/shared/dist — run `npm run build:shared` first.");
    // A readout exits 0; a READING with nothing to count is an absence, and
    // only a non-zero exit keeps it from being recorded as a number.
    return flag("--reading") || flag("--unproven") ? 1 : 0;
  }
  const { CLI_SIGNALS } = await import(pathToFileURL(CATALOG).href);
  const manifestFile = readJson(MANIFEST);

  if (flag("--unproven")) {
    // Version-free, so neither the installed CLI nor the live record is asked.
    const sigs = manifestFile?.signals;
    const got = unprovenCount(sigs ? CLI_SIGNALS.map((s) => rowFor(s, sigs[s.id], null, null, null)) : [], sigs);
    if (got.value === null) {
      console.error(`screenfixtures: ${got.reason}.`);
      return 1;
    }
    console.log(JSON.stringify(got.value));
    return 0;
  }

  if (flag("--debt")) {
    // Version-free: every capture the host kept counts, whatever CLI drew it.
    let got;
    try {
      const dir = opt("--captures") ?? join(await stateDir(), "clifixtures");
      got = harvestDebt(listSamples(dir, new Set(CLI_SIGNALS.map((s) => s.id))).samples, manifestFile, existsSync(dir));
    } catch (err) {
      got = { value: null, reason: `the capture dir could not be read (${err.message})` };
    }
    if (got.value === null) {
      console.error(`screenfixtures: ${got.reason}.`);
      return 1;
    }
    console.log(JSON.stringify(got.value));
    return 0;
  }

  const manifest = manifestFile?.signals ?? {};
  const health = readJson(opt("--health") ?? join(await stateDir(), "clihealth.json"));
  const installed = (opt("--cli") ? parseVersion(opt("--cli"))?.join(".") ?? null : null) ?? installedCli() ?? (parseVersion(health?.version) ? parseVersion(health.version).join(".") : null);
  const releases = flag("--npm") ? npmReleases() : null;
  const now = Date.now();

  const known = new Set(CLI_SIGNALS.map((s) => s.id));
  const captureDir = opt("--captures") ?? join(await stateDir(), "clifixtures");
  let samples = [], captured = null, captureError = null;
  try { samples = listSamples(captureDir, known).samples; captured = capturedOn(samples, installed); } catch (err) { captureError = err.message; }
  const rows = CLI_SIGNALS.map((s) => rowFor(s, manifest[s.id], health?.signals?.[s.id], installed, releases, captured));
  const strays = Object.keys(manifest).filter((k) => !known.has(k));

  if (flag("--reading")) {
    // Proof (b) and (c) are read off the host's state; without them a count
    // would claim "unproved" for signals nobody here could look at. A missing
    // capture dir beside a readable record is the host having captured
    // nothing yet, which IS a reading.
    const blind = !manifestFile?.signals ? "packages/host/test/fixtures/signals.json is missing or unreadable"
      : !health ? "no readable clihealth.json on this desktop (is the host's state dir here?), so the live proof cannot be asked"
      : captureError ? `the capture dir could not be read (${captureError})` : null;
    const got = blind ? { value: null, reason: blind } : noProofCount(rows, installed);
    if (got.value === null) {
      console.error(`screenfixtures: ${got.reason}.`);
      return 1;
    }
    console.log(JSON.stringify(got.value));
    return 0;
  }

  if (flag("--json")) {
    console.log(JSON.stringify({ installed, releasesCounted: !!releases, rows, strays }, null, 2));
    return 0;
  }

  console.log(`Installed claude: ${installed ? `v${installed}` : "unknown"}${flag("--npm") && !releases ? " (npm registry did not answer; gaps are patch numbers)" : ""}`);
  console.log("");
  const w = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) console.log(`${r.state.padEnd(8)} ${r.id.padEnd(w)}  ${sentence(r, now)}`);
  const none = rows.filter((r) => r.state === "none").length;
  const behind = rows.filter((r) => r.state === "behind").length;
  console.log("");
  console.log(`${rows.length - none} of ${rows.length} signals have a real capture behind them; ${behind} of those are behind the installed CLI.`);
  const unproved = rows.filter((r) => r.proof.length === 0);
  if (installed) console.log(`${unproved.length} of ${rows.length} have no proof on v${installed} (no fixture, host capture or live good from it)${unproved.length ? `: ${unproved.map((r) => r.id).join(", ")}` : ""}.`);
  const debt = captureError ? null : harvestDebt(samples, manifestFile, existsSync(captureDir)).value;
  if (debt) console.log(`${debt} host capture(s) have no repo fixture yet; \`node tools/harvestfixtures.mjs\` lists them and says which it would refuse.`);
  if (captureError) console.log(`The capture dir ${captureDir} could not be read (${captureError}); captures were not counted as proof.`);
  if (strays.length) console.log(`signals.json lists ${strays.length} id(s) the catalog does not have: ${strays.join(", ")}.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
