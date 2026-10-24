#!/usr/bin/env node
/**
 * `node tools/repohealth.mjs` — the command line of the repo-health series.
 *
 * ── Why this file holds no logic at all ─────────────────────────────────────
 *
 * Everything below is argument parsing, a loop, and printing. Not one metric,
 * not one git call, not one threshold. The reason is that this is the file
 * anybody will reach for when they want the tool to say something slightly
 * different — one more number in the summary, a special case for today — and
 * a definition that lands here is a definition that `fixture.json` does not
 * pin and `constants.mjs` does not version. The series would then quietly mean
 * something different depending on whether it came from the CLI or from the
 * test. So: `git.mjs` spawns, `snapshot.mjs` defines, `metrics/*` measure,
 * `series.mjs` stores and reads, and this file only chooses which of them runs.
 *
 * ── Why `judge` is imported lazily and nothing else is ──────────────────────
 *
 * This whole tool is deterministic and free: git, regex, arithmetic. Exactly
 * one module — `judge.mjs` — is permitted to spend tokens, and it does so only
 * when a person names an event and confirms. A top-level `import` of it would
 * put a model call one transitive import away from `update`, which runs
 * unattended; and an unattended spender is how a tool that cost nothing starts
 * costing something nobody chose. The dynamic `import()` inside the `judge`
 * branch is therefore load-bearing, not a style choice: it is what makes "the
 * free path cannot reach the paid one" true by construction and checkable as
 * text. `narrate`, `html` and `plot` are loaded the same way for the weaker
 * reason that `update` should not pay to parse them.
 *
 * ── What the other modules are expected to export ───────────────────────────
 *
 *   census.mjs       configure(root, git) -> the effective config: PREREG plus
 *                    the shape derived from THIS repo's tree. Built once per
 *                    run and passed as `prereg` to everything below.
 *   metrics/<m>.mjs  measure<M>(snapshot, history, index, prereg) -> Measured
 *                    tripwires additionally takes the previous row.
 *   narrate.mjs      narrate({root, prevDays, nextDays, prereg, preregVersion,
 *                             readRank}) -> {lines, events, unseen, written}
 *   readings.mjs     SERIES (which series exist) and reading(readRank, full,
 *                    prereg, def) (how one is read) — the narrative and the
 *                    plot import both; neither keeps a second copy.
 *   plot.mjs         buildPlot({rows, prereg, preregVersion}) -> the document
 *                    the phone draws
 *   html.mjs         writeHtml({root, days, tape}) -> {rel, written, lines}
 *   judge.mjs        bundle({id}, root, {prereg}) then run(b, {confirm, root})
 *
 * Usage:
 *   node tools/repohealth.mjs [update] [--fixture]
 *   node tools/repohealth.mjs status
 *   node tools/repohealth.mjs narrate
 *   node tools/repohealth.mjs html
 *   node tools/repohealth.mjs plot [--fixture]
 *   node tools/repohealth.mjs judge <event-id> [--yes]
 */
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configure } from "./repohealth/census.mjs";
import { stateFile } from "./repohealth/statefile.mjs";
import { normalizeScope, scopeHistory, slugFor } from "./repohealth/scope.mjs";
import * as git from "./repohealth/git.mjs";
import { buildSnapshot, deriveGroups } from "./repohealth/snapshot.mjs";
import { isSource } from "./repohealth/source.mjs";
import {
  append,
  load,
  missingShas,
  perDay,
  preregVersions,
  readRank,
  staleRows,
  stringifyRow,
  writeFixture,
} from "./repohealth/series.mjs";

import { measureSize } from "./repohealth/metrics/size.mjs";
import { measureHatches } from "./repohealth/metrics/hatches.mjs";
import { measureContext } from "./repohealth/metrics/context.mjs";
import { measureUntested } from "./repohealth/metrics/untested.mjs";
import { measureClassics } from "./repohealth/metrics/classics.mjs";
import { measureRetouch } from "./repohealth/metrics/retouch.mjs";
import { measureCochange } from "./repohealth/metrics/cochange.mjs";
import { measureDups } from "./repohealth/metrics/dups.mjs";
import { measureDeadExports } from "./repohealth/metrics/deadexports.mjs";
import { measureTripwires } from "./repohealth/metrics/tripwires.mjs";
import { OWN_FILE, declaresOwn, measureOwn } from "./repohealth/own.mjs";
import { declarationsByIndex, measureCentral } from "./repohealth/central.mjs";

/**
 * ── The measured root and the engine's own root are different things ───────
 *
 * This file used to derive one path and call it both. `ROOT` was the script's
 * own parent, so the tool measured whatever tree it happened to be checked out
 * in — which is why a repo without a copy of it had no readings at all, and
 * copying 10k lines into every repo was the only way to get them. The engine is
 * now told which tree to measure (`--root=<path>`), and everything it WRITES
 * follows that tree: the series, the narrative, the drawn page.
 *
 * `FIXTURE` does not. It is this engine's own pin — the rows it re-derives in
 * its own test to prove a definition did not move — and it belongs beside the
 * code that defines the metrics, never in the tree being measured. A repo being
 * read by this engine has no business holding a copy of waterplane's history.
 *
 * `--root=<path>` is ONE argv token, not two. The parser below splits words
 * from flags on a leading `--`, and an older copy of this tool (a repo may
 * carry its own) would take a second word as its subcommand and exit 2 on it.
 * As one token it is a flag to every parser this tool has ever had: ignored by
 * the old one, read by this one.
 *
 * The default is the SCRIPT's parent and deliberately not `cwd`. A
 * `node tools/repohealth.mjs` typed from inside `packages/web` would otherwise
 * measure that subdirectory and write `packages/web/<state dir>/` — a second series
 * nobody asked for, in a place nobody looks. The daemon always passes the flag.
 */
const ENGINE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The tree to measure: `--root=<path>`, else the engine's own tree. Resolved
 *  against cwd when relative, so `--root=../other` works from a shell. */
function resolveRoot(argv) {
  const flag = argv.find((a) => a.startsWith("--root="));
  if (!flag) return ENGINE_ROOT;
  const raw = flag.slice("--root=".length);
  if (!raw) throw new Error("--root= needs a path");
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  // Said here rather than left to the first git call: "not a directory" is a
  // typo in the flag, and the reader is looking at the flag. Whether it is a
  // git repository is git's answer to give (`git.mjs`), not a second stat.
  try {
    if (!statSync(abs).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`--root=${raw} is not a directory`);
  }
  return abs;
}

const ROOT = resolveRoot(process.argv.slice(2));

/**
 * The SUBTREE to measure, or null for the whole repo.
 *
 * `--scope=apps/ba3-web` measures that directory as though it were the repo:
 * its own groups, its own instructions, its own commits. `scope.mjs` argues the
 * mechanism out; what belongs here is that it is one argv token for the reason
 * `--root=` is (an older copy of this tool must ignore a flag, never read a
 * path as a subcommand), and that it picks a DIFFERENT series file.
 *
 * Two series in one file would be two histories in a reader written for one:
 * `missingShas` would think the backfill was done, `perDay` would fold two
 * subtrees into one day, and a rank would be taken over a window half of which
 * is somebody else's code.
 */
function resolveScope(argv) {
  const flag = argv.find((a) => a.startsWith("--scope="));
  return flag ? normalizeScope(flag.slice("--scope=".length)) : null;
}

const SCOPE = resolveScope(process.argv.slice(2));
/** The repo's committed `run` commands are not to be spawned (the host passes it until they are approved). */
const NO_OWN = process.argv.slice(2).includes("--no-own");
const SERIES = stateFile(ROOT, SCOPE ? `repohealth.${slugFor(SCOPE)}.jsonl` : "repohealth.jsonl");
const FIXTURE = join(ENGINE_ROOT, "tools", "repohealth", "fixture.json");
/** This script, as a reader would type it. See `recutCommand`. */
const ENGINE_CLI = fileURLToPath(import.meta.url);

const short = (sha) => sha.slice(0, 7);

/**
 * The effective configuration of the tree being measured — the pre-registered
 * method plus everything `census.mjs` derives from what is actually in this
 * repo — built once and handed to everything.
 *
 * Once, because activation is a fact about the tree at HEAD and reading it
 * twice in one process could only produce the same answer at a cost. Lazily,
 * because it is the first thing that spawns git: built at module scope, a
 * `--root` that is not a repository would print a stack trace from an import
 * instead of the sentence `git.mjs` wrote for exactly that case, and
 * `usage`/`unknown command` would pay for a tree listing before saying they
 * did not understand.
 *
 * Every subcommand needs it, not only `update`. `plot` and `narrate` read a
 * rank against `PREREG`'s window and print the version a row was measured
 * under; `status` says which definition the next `update` would write. A
 * command that built its own would be the second definition of the series
 * that this tool's whole shape exists to prevent.
 */
let CFG_MEMO = null;
function cfg() {
  // SCOPED, when there is one: the census is "which languages are in this
  // tree", and under a scope the tree is the subtree. Reading the repo's
  // census for a subtree would activate packs for languages that are not in
  // it and print their file counts as the denominators of its absences.
  return (CFG_MEMO ??= configure(ROOT, git, undefined, SCOPE));
}

/**
 * The one line a reader runs to re-cut a series under the current definition.
 *
 * It named neither of the two paths it needed: `rm <state dir>/repohealth.jsonl`
 * is relative to whatever directory the reader is standing in, and
 * `node tools/repohealth.mjs` is the engine's path inside the engine's own
 * repo. With `--root` both are wrong the moment the tree being measured is
 * not the tree holding this script — the reader would delete a series that
 * was not the one refused, and run a copy of the tool that may not exist.
 *
 * So both are absolute and the flag travels: the series that is actually
 * being read, the script that is actually running, and the root it was
 * actually pointed at. It is also the string the phone prints, which is why
 * it is built here and sent on `status` rather than copied into a client —
 * a copy would be right in one repo and wrong in every other.
 */
function recutCommand() {
  // `resolve` only to drop the trailing slash the engine's default root
  // carries from `new URL("..")` — a path a reader retypes should not have
  // one, and `join` has already normalised `SERIES`.
  const scope = SCOPE ? ` --scope=${SCOPE}` : "";
  return `rm ${SERIES} && node ${ENGINE_CLI} update --root=${resolve(ROOT)}${scope}`;
}

/**
 * `Row.tripwires` is a bare list, while every `measure*` returns a `Measured`.
 * A tripwire that could not be evaluated is not an event, so an absent
 * measurement becomes no events rather than a row that claims something fired.
 */
/** The repo's head paths, cut to the scope and re-rooted. One line here rather
 *  than an import: `scope.mjs` cuts a commit's TREE ENTRIES, and this is a
 *  bare path list off `listHeadPaths`. */
function headPaths(paths, scope) {
  if (!scope) return paths;
  const pre = `${scope}/`;
  return paths.filter((p) => p.startsWith(pre)).map((p) => p.slice(pre.length));
}

function tripwiresOf(measured) {
  if (Array.isArray(measured)) return measured;
  return measured && Array.isArray(measured.value) ? measured.value : [];
}

/**
 * The events a commit fired AND the state its successor needs to tell the next
 * transition from a standing fact.
 *
 * Both, together, or neither works: without `tripwireState` on the row, the
 * next process starts from no baseline, every tripwire reads as "nothing
 * crossed anything", and the append-only log records that permanently. That
 * was the bug — the state used to live in a module-level memo, which is empty
 * in every fresh `update`.
 */
function tripwireFields(measured) {
  return { tripwires: tripwiresOf(measured), tripwireState: measured?.state ?? null };
}

/**
 * What to say and do when the file on disk holds rows from more than one
 * definition — a different engine version, a different set of active packs,
 * or both (`EffectivePrereg.VERSION` carries the two halves).
 *
 * It refuses. It does not rewrite the file, and it does not recompute the old
 * rows under the new definition — both of those are a silent rewrite of what
 * every past day meant, which is the one thing `constants.mjs` and the fixture
 * exist to make loud. The remedy is one line the reader runs themselves, and
 * whether the old series is worth keeping a copy of first is their call, not
 * this tool's. Nothing applies itself.
 *
 * @returns {boolean} true when the caller must stop.
 */
function refuseMixedPrereg(rows, version) {
  const seen = preregVersions(rows);
  if (seen.length < 2 && (seen.length === 0 || seen[0].version === version)) return false;

  const lines = seen.map(
    (v) =>
      `  ${v.version}${v.version === version ? " (current)" : ""}: ` +
      `${v.rows} row${v.rows === 1 ? "" : "s"}`,
  );
  process.stderr.write(
    `repohealth: refusing to append — the series was measured under a different definition.\n` +
      lines.join("\n") +
      "\n" +
      "Appending would put rows measured under two definitions of the same metric\n" +
      "on one plot, and every row would still be individually correct. Recomputing\n" +
      "the old ones silently is the same rewrite with the evidence removed.\n" +
      "To re-cut the whole history under the current definition:\n" +
      `  ${recutCommand()}\n`,
  );
  return true;
}

/**
 * How many measured commits are written before the next one is measured, and
 * how often the progress line is printed. One number, because they are the
 * same decision: the stride at which a long run reports is the stride at which
 * it is worth making durable.
 *
 * A backfill used to append ONCE, after the whole loop. The daemon kills a step
 * at `WATERPLANE_REPOHEALTH_TIMEOUT_MS` (180s by default) and told the reader
 * "nothing it had already written was undone" — which was true only because
 * nothing had been written at all. On this repo (170 first-parent commits, ~20
 * seconds) that never showed; on a repo of 1,300 it means the series can never
 * be measured from a phone, because every attempt is cut at the same place and
 * throws away everything it did. Appending as it goes makes a cut run a partial
 * run: `missingShas` resumes from the rows on disk, and the file stays
 * append-only, in history order, with no row written twice.
 */
const CHUNK = 25;

/**
 * Backfill on the first run, one commit at a time after that.
 *
 * The loop is per COMMIT, not per day: `perDay` reduces afterwards, and
 * throwing away the intermediate commits here would mean they could never be
 * recovered without recomputing the series under today's constants.
 */
/** Rewrite the file's LAST line for `row.sha` in place (atomically); the rest, stale rows included, stays byte for byte. */
function replaceRow(path, row) {
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let sha;
    try { sha = JSON.parse(lines[i]).sha; } catch { continue; }
    if (sha !== row.sha) continue;
    lines[i] = stringifyRow(row);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, lines.join("\n"), "utf8");
    renameSync(tmp, path);
    return;
  }
}

function update({ fixture }) {
  const started = Date.now();
  const CFG = cfg();
  const raw = git.readHistory(ROOT, CFG);
  let history = scopeHistory(raw, SCOPE, CFG);
  if (SCOPE && !history.commits.length) {
    throw new Error(`no first-parent commit touches ${SCOPE} — there is nothing to measure under that scope.`);
  }
  const onDisk = load(SERIES);
  if (refuseMixedPrereg(onDisk, CFG.VERSION)) {
    process.exitCode = 3;
    return;
  }
  // Rows for shas that left first-parent are dropped from the read and left in
  // the file — see `staleRows`. The count is printed in the summary, at 0 as
  // well, because a rewritten branch that nobody mentions is exactly how one
  // goes unnoticed.
  const { rows, stale } = staleRows(onDisk, history.commits);
  const missing = new Set(missingShas(rows, history.commits));
  const known = new Map(rows.map((r) => [r.sha, r]));
  // Line-level history, for `retouch`'s rework test — the one expensive git
  // read, so only when there is a row to measure (`git.readHunks` states the
  // cost). Attached to the unscoped history and re-scoped with it.
  if (missing.size) {
    raw.hunks = git.readHunks(ROOT);
    history = scopeHistory(raw, SCOPE, CFG);
  }
  // The health.json in force at each commit, for `central` — whole tree only,
  // like the repo's own readings: the declaration is about the repo's index.
  const decls = !SCOPE && missing.size ? declarationsByIndex(ROOT, history, git) : null;

  const fresh = [];
  /** Rows measured since the last append. See `CHUNK` — a backfill that is cut
   *  keeps what it had already measured, and the next run resumes from it. */
  let pending = [];
  let prevRow = rows.length ? rows[rows.length - 1] : null;
  let done = 0;
  history.commits.forEach((commit, index) => {
    if (!missing.has(commit.sha)) {
      prevRow = known.get(commit.sha) ?? prevRow;
      return;
    }
    const snap = buildSnapshot(ROOT, commit.sha, git, CFG, SCOPE);
    const row = {
      sha: commit.sha,
      day: commit.day,
      ts: commit.ts,
      batch: commit.batch,
      prereg: CFG.VERSION,
      size: measureSize(snap, history, index, CFG),
      retouch: measureRetouch(snap, history, index, CFG),
      hatches: measureHatches(snap, history, index, CFG),
      dups: measureDups(snap, history, index, CFG),
      deadExports: measureDeadExports(snap, history, index, CFG),
      cochange: measureCochange(snap, history, index, CFG),
      context: measureContext(snap, history, index, CFG),
      untested: measureUntested(snap, history, index, CFG),
      classics: measureClassics(snap, history, index, CFG),
      ...tripwireFields(measureTripwires(snap, history, index, CFG, prevRow)),
    };
    // The repo's OWN readings (`own.mjs`): HEAD only, the whole tree only. Not
    // one of the measurements above — no definition here moves when a repo
    // declares one, and nothing that reads the five index entries reads this.
    // `--no-own`: the host has not approved this repo's committed commands, so
    // none of them runs (neither its readings here nor its central overrides).
    if (!SCOPE && !NO_OWN && index === history.commits.length - 1) {
      const own = measureOwn(ROOT, commit.sha, git);
      if (own) row.own = own;
    }
    // The repo's say over the CENTRAL readings (`central.mjs`): a disable is
    // honoured on every commit that declared it, an override RUNS at HEAD only
    // — so an override's series starts at its first measurement, and the
    // fingerprint on the row is what carries the index across that start.
    if (decls) {
      const central = measureCentral(ROOT, decls[index], { atHead: !NO_OWN && index === history.commits.length - 1 });
      if (central) row.central = central;
    }
    fresh.push(row);
    pending.push(row);
    prevRow = row;
    done++;
    // Backfill is the slow path and it is silent for minutes otherwise; on
    // stderr so a `> file` of the summary stays clean.
    if (done % CHUNK === 0) {
      append(SERIES, pending);
      pending = [];
      process.stderr.write(`  …${done}/${missing.size} commits\n`);
    }
  });

  append(SERIES, pending);
  // A HEAD row measured under `--no-own` (the bundled engine, before the person
  // approved the repo's commands) has no `own`, and `missing` will never visit it
  // again: re-measure that one row's own + central readings and rewrite it.
  const headIdx = history.commits.length - 1;
  const headKnown = headIdx >= 0 ? known.get(history.commits[headIdx].sha) : null;
  if (!SCOPE && !NO_OWN && headKnown && !headKnown.own && declaresOwn(ROOT, headKnown.sha, git)) {
    const own = measureOwn(ROOT, headKnown.sha, git);
    const central = measureCentral(ROOT, git.readFileAt(ROOT, headKnown.sha, OWN_FILE), { atHead: true });
    const redone = { ...headKnown, ...(own ? { own } : {}), ...(central ? { central } : {}) };
    if (own || central) {
      replaceRow(SERIES, redone);
      rows[rows.indexOf(headKnown)] = redone;
    }
  }
  const all = rows.concat(fresh);
  const last = all[all.length - 1];
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const staleNote = `, ${stale} stale row${stale === 1 ? "" : "s"} ignored`;
  if (!fresh.length) {
    console.log(
      `repohealth: nothing new — ${all.length} rows, through ${short(last.sha)} (${last.day})${staleNote}.`,
    );
  } else {
    console.log(
      `repohealth: +${fresh.length} rows (${all.length} total, ${perDay(all).length} days), ` +
        `through ${short(last.sha)} (${last.day}), ${git.blobCacheSize()} blobs read, ${secs}s${staleNote}.`,
    );
  }

  if (fixture) {
    // Without `own` or `central`: the fixture pins waterplane's definitions,
    // which a row can be recomputed into from its sha alone. A repo's own
    // reading — and an override of a central one — ran a program against a
    // checkout at one moment and cannot be.
    const days = perDay(all).map(({ own: _own, central: _central, ...r }) => r);
    writeFixture(FIXTURE, { prereg: CFG.VERSION, lastSha: last.sha, rows: days });
    console.log(`repohealth: wrote tools/repohealth/fixture.json — ${days.length} per-day rows.`);
  }
}

/**
 * ONE JSON line saying what is in the series file and how far behind HEAD it is.
 *
 * ── Why a subcommand and not a reader on the other side ────────────────────
 *
 * The daemon that drives this from a phone needs exactly three facts before it
 * can draw anything: how much series there is, which definition it was measured
 * under, and whether it is behind the tree. Every one of those is a question
 * about which rows COUNT — `staleRows` drops the shas that left first-parent,
 * `preregVersions` is what a mixed series is, `perDay` is what a day is —
 * and a second implementation of any of them would be a second definition of
 * the series that agrees today and drifts silently afterwards. That is the drift
 * `constants.mjs` and `fixture.json` exist to catch, and it cannot catch a copy
 * living outside this tool. So the answer is computed here, by the modules that
 * own it, and printed.
 *
 * ── Why it exits 0 on a series it would refuse to append to ────────────────
 *
 * `update` refuses a mixed series because appending would put rows measured
 * under two definitions on one plot. Reading is not appending: a reader that
 * refused to say "this series is mixed" would withhold the one sentence that
 * explains the plot. So `mixed` and `stale` are FIELDS, exit code 0, and the
 * caller decides what to say about them. A non-zero exit is reserved for "this
 * did not run", which is a different fact entirely.
 */
function status() {
  const CFG = cfg();
  const onDisk = load(SERIES);
  // Under a scope the COMMITS are the ones that touched it — so "behind" is
  // how many changes to this subtree are unmeasured, and `commits` is the size
  // of its backfill rather than the repo's. Reading the numstat log to get
  // that is the extra cost of a scoped read, and it is the only honest source:
  // `rev-list` alone cannot say which commits touched a directory without
  // being asked, and asking it per scope is the same walk.
  const commits = SCOPE
    ? scopeHistory(git.readHistory(ROOT, CFG), SCOPE, CFG).commits
    : git.listCommits(ROOT);
  const { rows, stale } = staleRows(onDisk, commits);
  const versions = preregVersions(onDisk);
  const days = perDay(rows);
  const last = rows.length ? rows[rows.length - 1] : null;
  const head = commits.length ? commits[commits.length - 1] : null;
  // Commits AFTER the last measured one, and `null` when that cannot be told
  // apart from zero: an empty series, or a `lastSha` the live history no longer
  // contains. A 0 here is the claim that the plot is current, so it is only
  // ever printed when it was actually counted.
  const at = last ? commits.findIndex((c) => c.sha === last.sha) : -1;
  const behind = at < 0 ? null : commits.length - 1 - at;
  process.stdout.write(
    JSON.stringify({
      // Which subtree this answer is about, echoed rather than assumed: a
      // scoped status and a repo-wide one are the same shape, and a reader
      // holding one with no scope beside it cannot tell which it has.
      scope: SCOPE,
      preregVersion: last?.prereg ?? CFG.VERSION,
      rows: rows.length,
      days: days.length,
      staleRows: stale,
      versions,
      lastSha: last?.sha ?? null,
      lastDay: last?.day ?? null,
      lastTs: last?.ts ?? null,
      head: head ? { sha: head.sha, ts: head.ts } : null,
      behind,
      // ── what a reader needs BEFORE the first row exists ──
      //
      // Additive fields, not a second subcommand: `RepoHealthStep` is a
      // closed union on the host side with a text assertion behind it, so a
      // new verb is a change in three places and a field is a change in one.
      // Every one of these is already computed here or one call away, and
      // each answers a question the phone otherwise cannot ask at all on a
      // repo with an empty series — where `preregVersion` falls back to the
      // engine's own and every other field above is null or 0.
      //
      // `commits` is the size of the job: the first-parent walk this tool
      // would measure, which is what makes "0 rows" readable as "1,300
      // commits to go" rather than as "nothing here".
      commits: commits.length,
      // The definition the NEXT row would be written under, whatever the
      // rows on disk say. `preregVersion` above is the series'; these two
      // differ exactly when a re-cut is pending, which is the thing a reader
      // is trying to find out.
      engineVersion: CFG.VERSION,
      // Which languages this engine could read here, with two counts each. A
      // repo where this is `common` alone is one whose source no pack claims,
      // and saying so once here is cheaper than repeating it in every row.
      //
      // `files` is the MEASURED population — what `isSource` selected and
      // this pack would be handed — and it is the denominator for every
      // absence the rows carry. `extFiles` is what activated the pack: every
      // file carrying one of its extensions outside the excluded
      // directories. The two are published side by side because they answer
      // different questions and one used to answer both: measured at HEAD,
      // `Tiptoi` printed "kotlin, 242 files" beside absences whose population
      // was 176, and this repo "typescript, 646" against 385, because the
      // activation count applies the excluded directories and stops there.
      packs: CFG.PACKS.map((p) => ({ name: p.name, version: p.version, files: p.files, extFiles: p.extFiles })),
      // The boundaries co-change stops at, LOC is broken down by, and an
      // area's source is named from — derived at HEAD by the same function
      // each snapshot uses, over the same `isSource`, so this is a preview of
      // the rows rather than a second opinion about them.
      // Under a scope these are the SUBTREE's groups, re-rooted with everything
      // else — the same list the scoped plot's bands carry, and the candidates
      // a client offers when it asks which part to break down next.
      groups: deriveGroups(
        headPaths(git.listHeadPaths(ROOT), SCOPE).filter((path) => isSource(path, CFG)),
      ),
      // The remedy line, built where both paths are known. The alternative is
      // a copy of this string in the client, which would be right in the
      // engine's own repo and wrong in every other tree it measures.
      recut: recutCommand(),
    }) + "\n",
  );
}

/**
 * The days to read, or a message that says what to run instead of a stack.
 *
 * Two things are said on stderr rather than done. A read does not refuse the
 * way `update` does — refusing to draw the plot would remove the only view of
 * the problem it is refusing over — but it must not present a mixed or stale
 * series as one clean reading either, so both are named and the page and the
 * narrative go to stdout unpolluted.
 *
 * `listCommits` is a `rev-list` and nothing else: the day series is filtered
 * against the live first-parent history, so a rebased or amended commit stops
 * contributing a point the moment it stops being in the history, instead of
 * outliving it in the file forever.
 */
/**
 * Said, not done: a mixed series is still drawn, with the sentence that
 * explains the shape printed beside it on stderr. Shared by every read so the
 * warning cannot be present on one page and absent on another.
 */
/** The two subcommands that write a file for a person to open — see `narrate`. */
function refuseScope(cmd) {
  if (SCOPE) {
    throw new Error(`${cmd} has no --scope: it writes one file for the repo. Use plot --scope=${SCOPE} for a subtree's readings.`);
  }
}

function warnMixed(rows) {
  const seen = preregVersions(rows);
  if (seen.length > 1) {
    process.stderr.write(
      `repohealth: WARNING — this series mixes ${seen.length} definitions ` +
        `(${seen.map((v) => `${v.version}: ${v.rows}`).join(", ")}). ` +
        "One line is being drawn through rows that do not measure the same thing.\n",
    );
  }
}

function days() {
  const onDisk = load(SERIES);
  if (!onDisk.length) {
    throw new Error("no series yet — run `node tools/repohealth.mjs update` first");
  }
  warnMixed(onDisk);
  const { rows, stale } = staleRows(
    onDisk,
    SCOPE ? scopeHistory(git.readHistory(ROOT, cfg()), SCOPE, cfg()).commits : git.listCommits(ROOT),
  );
  if (stale) {
    process.stderr.write(
      `repohealth: ${stale} row${stale === 1 ? "" : "s"} ignored — ` +
        `${stale === 1 ? "its commit is" : "their commits are"} no longer on first-parent.\n`,
    );
  }
  if (!rows.length) {
    throw new Error("every row in the series is for a commit that left first-parent");
  }
  return perDay(rows);
}

/**
 * `series.mjs`'s `readRank` is handed to the narrator whole — it now cuts its
 * own trailing window, so there is nothing left for an adapter to do and no
 * second place where "how far back is recent" could be decided differently.
 *
 * The window is the last `RANK_WINDOW_DAYS` READINGS, not calendar days:
 * `windowFor` in `events.mjs` drops the absences before the values get here,
 * so the days are already gone and a calendar cut through this seam could
 * only be a guess. `series.mjs`'s header argues it out.
 */

async function narrate() {
  // Root only, and said rather than silently ignored. Both of these WRITE into
  // the repo — the narrative into `.claude/outbox/`, the page beside it — and
  // one file per subtree is a repo littered with pages nobody asked for, each
  // claiming to be the repo's own. The readings of a scope travel as `plot`,
  // which writes nothing.
  refuseScope("narrate");
  const nextDays = days();
  const { narrate: run } = await import("./repohealth/narrate.mjs");
  // `prevDays: []` and the whole series as `nextDays`: every day is offered,
  // and the ledger inside `narrate.mjs` is what stops a sentence printing
  // twice. Deciding here which days are "new" would be a second ledger.
  const CFG = cfg();
  const res = run({
    root: ROOT,
    prevDays: [],
    nextDays,
    prereg: CFG,
    preregVersion: CFG.VERSION,
    readRank,
  });
  for (const line of res?.lines ?? []) console.log(line);
}

async function html() {
  refuseScope("html");
  const rows = days();
  // `html.mjs` owns the page and writes it itself — including the full path it
  // wrote, which is the line the reader needs. The CLI's job is to hand it the
  // per-day series and the one thing that is not in a row: the LOC-per-file
  // tape. That lives in the LATEST row's `classics`, because a tape is a
  // distribution of today, not a point in a series; every earlier row carries
  // its own and none of them belong on this page.
  const { writeHtml } = await import("./repohealth/html.mjs");
  const latest = rows.length ? rows[rows.length - 1] : null;
  const tape = latest?.classics?.value?.tape ?? undefined;
  const res = writeHtml({ root: ROOT, days: rows, tape, log: (l) => console.log(`repohealth: ${l}`) });
  if (!res?.written) console.log("repohealth: nothing drawn");
}

/**
 * ONE JSON line holding every series as POINTS, for a client that can draw.
 *
 * The document is `plot.mjs`'s — the rank, the slope, the window a rank was
 * taken in and every absence's reason are shaped there, beside the reading
 * they are taken with. What is left here is the part this file is for:
 * choosing which rows to read, and printing.
 *
 * Read-only, and it exits 0 on a series `update` would refuse to extend, for
 * the reason `status` does — refusing to hand over the plot would withhold the
 * only view of the problem it is refusing over.
 *
 * `--fixture` reads the committed fixture instead of `<state dir>/repohealth.jsonl`
 * — the hermetic path the test runs, so what is pinned is what a clone with no
 * series of its own can still reproduce. (On `update` the same flag WRITES
 * that file; here nothing is written at all.)
 */

/** The day-rows to plot: the series on disk, or the committed fixture. */
function plotRows({ fixture }) {
  if (!fixture) return days();
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const rows = Array.isArray(fx.rows) ? fx.rows : [];
  if (!rows.length) throw new Error("the committed fixture holds no rows");
  warnMixed(rows);
  return rows;
}

async function plot({ fixture }) {
  const rows = plotRows({ fixture });
  const { buildPlot } = await import("./repohealth/plot.mjs");
  const CFG = cfg();
  // Whether HEAD declares own readings — a read of one committed blob, nothing
  // run. The fixture is waterplane's own pin and declares nothing.
  const head = fixture || SCOPE ? null : git.listCommits(ROOT).at(-1);
  const ownDeclared = head ? declaresOwn(ROOT, head.sha, git) : false;
  const doc = buildPlot({ rows, prereg: CFG, preregVersion: CFG.VERSION, scope: SCOPE, ownDeclared });
  process.stdout.write(JSON.stringify(doc) + "\n");
}

/**
 * The one paid command. Everything above this line is git, regex and
 * arithmetic; see the header for why the import is inside the branch.
 *
 * The event is passed as its id alone: `judge.mjs` reconstructs kind, subject
 * and sha from it and assembles its own evidence, so this file never decides
 * what is sent to a model. Exit 2 is "declined", which is not a failure — it
 * is the guard working — so it is not folded into the catch-all exit 1.
 */
async function judge(eventId, { yes }) {
  if (!eventId) throw new Error("usage: node tools/repohealth.mjs judge <event-id> [--yes]");
  const { bundle, run } = await import("./repohealth/judge.mjs");
  const b = bundle({ id: eventId }, ROOT, { prereg: cfg() });
  const res = await run(b, { confirm: yes, root: ROOT });
  process.exitCode = res?.code ?? 0;
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const words = argv.filter((a) => !a.startsWith("--"));
const cmd = words[0] ?? "update";

try {
  if (cmd === "update") update({ fixture: flags.has("--fixture") });
  else if (cmd === "status") status();
  else if (cmd === "narrate") await narrate();
  else if (cmd === "html") await html();
  else if (cmd === "plot") await plot({ fixture: flags.has("--fixture") });
  else if (cmd === "judge") await judge(words[1], { yes: flags.has("--yes") });
  else {
    process.stderr.write(
      `unknown command ${JSON.stringify(cmd)}\n` +
        "usage: repohealth.mjs [update [--fixture] | status | narrate | html | plot [--fixture] | " +
        "judge <event-id> [--yes]] [--root=<path>] [--scope=<subdir>]\n",
    );
    process.exit(2);
  }
} catch (err) {
  process.stderr.write(`repohealth: ${err.message}\n`);
  process.exit(1);
}
