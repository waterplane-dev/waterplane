/**
 * The exposure watch's readings and accepts, as setup-checklist rows.
 *
 * `tools/exposure.mjs` (a daily, model-free job) appends one row per run to
 * `<state dir>/exposure/<name>.jsonl` and keeps a person's accepts in
 * `<name>.accepted.json`. This module only READS the newest row and, on a tap,
 * writes that SAME accepts file — never `setupprefs.json` — because the release
 * gate reads it and an accept the gate cannot see would be a lie.
 *
 *  - **The CLI's exact dir**: `resolveStateDir()` (`branddirs.ts`) is the same
 *    `stateDirPick(env, home)` the CLI uses, made absolute (and WSL-mapped).
 *  - **Matched by REALPATH** of the row's `dir` against the worktree; no series
 *    for a repo means no rows at all (not a "never measured" warn).
 *  - **Never throws**: an unreadable file is no row; an unreadable accepts file
 *    is said in the summary row and is never overwritten by an accept.
 *  - **Cached by (mtime, size)** so the sweep (`setupwatch.ts`, every 10 minutes)
 *    does not re-read a file that did not change.
 *  - **A series that WAS readable and now is not** is never a clean checklist: the
 *    last-good (file -> dir) is remembered and that worktree gets a warn row.
 *  - **Deliberate CLI divergence**: the CLI records an accept for a key absent from the
 *    newest row and takes a past `--until-date`; this module refuses both (the phone can
 *    only show present rows).
 *  - **No lock**: the phone and the CLI can race on the same second; the accepts file is
 *    re-read right before the write, and the later write wins.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, fstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  PRE_ACCEPTED, applyAccepts, applyTriage, cleanAcceptRequest, cleanTriageFile, exposureKeyOf, exposureVersionStem, exposureChecks, readLastRow, semverCmp, EXPOSURE_SUMMARY_ID,
  exposureTriageId, type ComplianceAcceptRequest, type ComplianceCheck, type ComplianceTriageRequest, type ExposureAccept, type ExposureRow,
  type ExposureFinding, type ExposureTriage, type ExposureTriageFile, type ExposureTriageState,
} from "@waterplane/shared";
import { resolveStateDir } from "./branddirs.js";
import { writeJsonAtomic } from "./jsonstore.js";

const TAIL_BYTES = 256 * 1024;
const WHOLE_FILE_MAX = 16 * 1024 * 1024;

let dirOverride: string | null = null;
/** Tests: read and write this dir instead of `<state dir>/exposure`. `null` restores the default. */
export function setExposureDir(dir: string | null): void {
  dirOverride = dir;
  rowCache.clear();
  lastGood.clear();
}
/** The exposure state dir (`<state dir>/exposure`, or the test override) — also where `targets.json` lives. */
export function exposureDir(): string { return seriesDir(); }
function seriesDir(): string {
  return dirOverride ?? join(resolveStateDir().dir, "exposure");
}

const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/** The tail of a file, as text (a row is one line, so the last 256 KB holds the newest). */
function readTail(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let text = buf.toString("utf8");
    if (size > len) {
      const nl = text.indexOf("\n");
      if (nl < 0 || !text.slice(nl + 1).trim()) { // the newest row is longer than the tail: read the whole file (bounded)
        if (size > WHOLE_FILE_MAX) return null;
        return readFileSync(path, "utf8");
      }
      text = text.slice(nl + 1); // drop the cut first line
    }
    return text;
  } catch { return null; } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** file -> the `dir` its newest row named, from the last read that worked. */
const lastGood = new Map<string, string>();
const rowCache = new Map<string, { sig: string; row: ExposureRow | null }>();
function newestRow(file: string): ExposureRow | null {
  try {
    const st = statSync(file);
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = rowCache.get(file);
    if (hit && hit.sig === sig) return hit.row;
    const t = readTail(file);
    const row = t === null ? null : readLastRow(t);
    rowCache.set(file, { sig, row });
    if (row && typeof row.dir === "string") lastGood.set(file, row.dir);
    return row;
  } catch { return null; }
}

interface Series { name: string; row: ExposureRow; acceptsFile: string; triageFile: string }
function seriesFor(worktree: string): Series | null {
  const dir = seriesDir();
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return null; }
  const want = real(worktree);
  for (const f of names.sort()) {
    const row = newestRow(join(dir, f));
    if (!row || typeof row.dir !== "string") continue;
    if (real(row.dir) === want || row.dir === worktree) {
      const name = f.slice(0, -".jsonl".length);
      return { name, row, acceptsFile: join(dir, `${name}.accepted.json`), triageFile: join(dir, `${name}.triage.json`) };
    }
  }
  return null;
}

/** Every stored series' newest row with its accepts, for the push sweep. Reuses `newestRow`'s mtime+size cache,
 *  so a quiet day costs one stat per file. A series with no readable row is skipped. Never throws. */
export function exposureSeriesAll(): Array<{ row: ExposureRow; accepts: Record<string, ExposureAccept> | null; triage: ExposureTriageFile | null; unreadable?: boolean }> {
  const out: Array<{ row: ExposureRow; accepts: Record<string, ExposureAccept> | null; triage: ExposureTriageFile | null; unreadable?: boolean }> = [];
  try {
    const dir = seriesDir();
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
      const row = newestRow(join(dir, f));
      if (!row || typeof row.dir !== "string") continue;
      const stem = f.slice(0, -".jsonl".length);
      const acc = readAccepts(join(dir, `${stem}.accepted.json`));
      const tri = readTriage(join(dir, `${stem}.triage.json`));
      out.push({ row, accepts: acc.ok ? acc.data : null, triage: tri.ok ? tri.data : null, ...(acc.ok && tri.ok ? {} : { unreadable: true }) });
    }
  } catch { /* no dir yet: nothing stored */ }
  return out;
}

/** A warn summary when a series we read before names this worktree but cannot be read now. */
function unreadableRow(worktree: string): ComplianceCheck[] {
  const dir = seriesDir();
  const want = real(worktree);
  for (const [file, rowDir] of lastGood) {
    if (!file.startsWith(dir) || !existsSync(file)) continue;
    if (!(real(rowDir) === want || rowDir === worktree)) continue;
    if (newestRow(file)) continue;
    return [unreadableSummary()];
  }
  return [];
}
const unreadableSummary = (): ComplianceCheck => ({
  id: EXPOSURE_SUMMARY_ID, label: "Exposure watch", status: "warn", fix: null, advisory: true,
  detail: "The stored reading could not be read, so nothing is known about this repo's exposure right now (not the same as clean).",
});

type Accepts = { ok: true; data: Record<string, ExposureAccept> | null } | { ok: false; why: string };
function readAccepts(file: string): Accepts {
  if (!existsSync(file)) return { ok: true, data: null };
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, why: "not an object" };
    return { ok: true, data: v as Record<string, ExposureAccept> };
  } catch (e) { return { ok: false, why: e instanceof Error ? e.message : String(e) }; }
}

type Triage = { ok: true; data: ExposureTriageFile | null } | { ok: false; why: string };
function readTriage(file: string): Triage {
  if (!existsSync(file)) return { ok: true, data: null };
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, why: "not an object" };
    return { ok: true, data: cleanTriageFile(v) }; // a malformed entry reads as no mark
  } catch (e) { return { ok: false, why: e instanceof Error ? e.message : String(e) }; }
}

/** The exposure rows for this worktree: none when no series names it. Never throws. */
export function exposureChecksFor(worktree: string): ComplianceCheck[] {
  try {
    const s = seriesFor(worktree);
    if (!s) return unreadableRow(worktree);
    const acc = readAccepts(s.acceptsFile);
    const tri = readTriage(s.triageFile);
    const rows = exposureChecks(s.row, s.name, acc.ok ? acc.data : null, new Date(), undefined, tri.ok ? tri.data : null);
    if (!tri.ok) {
      const sum = rows.find((c) => c.id === EXPOSURE_SUMMARY_ID);
      if (sum) {
        sum.status = "warn";
        sum.detail += ` The triage file could not be read (${tri.why}), so no seen / investigating / fixed mark is applied here.`;
      }
    }
    if (!acc.ok) {
      const sum = rows.find((c) => c.id === EXPOSURE_SUMMARY_ID);
      if (sum) {
        sum.status = "warn";
        sum.detail += ` The accepts file could not be read (${acc.why}), so nothing shown here counts as accepted except what is built in.`;
      }
    }
    return rows;
  } catch { return [unreadableSummary()]; }
}

export type ExposureAcceptOutcome = { ok: true } | { ok: false; error: string };

/** Accept (or stop accepting) one finding by writing the watch's own accepts file. */
export function setExposureAccept(worktree: string, req: ComplianceAcceptRequest): ExposureAcceptOutcome {
  const no = (error: string): ExposureAcceptOutcome => ({ ok: false, error });
  try {
    const c = cleanAcceptRequest(req, new Date());
    if (!c.ok) return no(c.error);
    const r = c.value;
    const key = exposureKeyOf(r.id);
    if (!key) return no("That row is not an exposure finding; only those can be accepted.");
    const s = seriesFor(worktree);
    if (!s) return no("No exposure watch reading is stored for this repo, so there is nothing to accept.");
    const f = s.row.findings?.find((x) => x.key === key);
    let entry: ExposureAccept | null = null;
    if (r.accept) {
      if (!f) return no("That finding is not in the newest reading any more.");
      entry = { reason: r.reason!, at: new Date().toISOString() };
      if (r.until) {
        if ("version" in r.until) {
          if (!f.version) return no(`${key} has no version to compare, so accepting until a version would never end: use a date or a change.`);
          if (semverCmp(r.until.version, f.version) <= 0) return no(`Pick a version newer than ${f.version}; otherwise the accept would already be over.`);
          entry.until = { version: r.until.version };
        } else if ("date" in r.until) entry.until = { date: r.until.date };
        else entry.until = { change: f.text };
      }
    }
    // Read the accepts file as late as possible: the CLI may have written it since the request began.
    const cur = readAccepts(s.acceptsFile);
    if (!cur.ok) return no(`${s.acceptsFile} is unreadable (${cur.why}); not overwriting it.`);
    const next: Record<string, ExposureAccept> = { ...(cur.data ?? {}) };
    if (entry) next[key] = entry;
    else {
      const stem = exposureVersionStem(key);
      const hit = Object.hasOwn(next, key) ? key
        : stem ? Object.keys(next).find((k) => exposureVersionStem(k) === stem && (next[k]?.until as { version?: string } | undefined)?.version !== undefined)
        : undefined;
      if (!hit) {
        return Object.hasOwn(PRE_ACCEPTED, key)
          ? no(`Accepted in code: ${PRE_ACCEPTED[key]!.reason}. That one is built in and is changed in the source, not here.`)
          : no("That finding is not accepted.");
      }
      delete next[hit];
    }
    mkdirSync(seriesDir(), { recursive: true });
    writeJsonAtomic(s.acceptsFile, next, { space: 2, newline: true });
    return { ok: true };
  } catch (e) {
    return no(`Could not save the accept: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const TRIAGE_STATES: readonly ExposureTriageState[] = ["seen", "investigating", "fixed"];

/**
 * Mark (or, with `clear`, unmark) one finding or crash group in `<name>.triage.json`, beside the accepts file.
 * `id` is a check id (`exposure:<key>`) or a triage id (`exposureTriageId`); it must name a finding in the newest
 * row. Never writes over an unreadable file. `by` is who is asking (a person from the phone, an agent from a route).
 */
export function setExposureTriage(worktree: string, req: ComplianceTriageRequest, by: ExposureTriage["by"] = { kind: "person" }): ExposureAcceptOutcome {
  const no = (error: string): ExposureAcceptOutcome => ({ ok: false, error });
  try {
    const id0 = typeof req?.id === "string" ? req.id.trim() : "";
    if (!id0) return no("Say which finding to mark.");
    const s = seriesFor(worktree);
    if (!s) return no("No exposure watch reading is stored for this repo, so there is nothing to mark.");
    const key = exposureKeyOf(id0);
    const f = (s.row.findings ?? []).find((x) => (key !== null ? x.key === key : exposureTriageId(x) === id0 || x.key === id0));
    const cur = readTriage(s.triageFile);
    if (!cur.ok) return no(`${s.triageFile} is unreadable (${cur.why}); not overwriting it.`);
    const next: ExposureTriageFile = { ...(cur.data ?? {}) };
    // A mark whose group is not in today's reading is kept (it may return); it can still be cleared by its id.
    if (!f && !(req.clear && Object.hasOwn(next, id0))) return no("That finding is not in the newest reading any more.");
    const tid = f ? exposureTriageId(f) : id0;
    if (req.clear) {
      if (!Object.hasOwn(next, tid)) return no("That finding has no mark to clear.");
      delete next[tid];
    } else {
      if (!TRIAGE_STATES.includes(req.state as ExposureTriageState)) return no('State must be "seen", "investigating" or "fixed".');
      const e: ExposureTriage = { state: req.state as ExposureTriageState, at: new Date().toISOString(), by, ...(f!.appVersion ? { markedVersion: f!.appVersion } : {}) };
      if (req.state === "fixed") {
        if (!f!.appVersion) return no("fixed needs a crash group with an app version; accept it instead (a fix is compared against the version that reports the crash).");
        const v = typeof req.fixedIn === "string" ? req.fixedIn.trim() : "";
        if (!v) return no('"fixed" needs the version that carries the fix (fixedIn), so installs still on an older one are not called regressions.');
        if (v.length > 32 || !/^[0-9A-Za-z.+-]+$/.test(v)) return no("fixedIn must be a version of at most 32 characters (letters, digits, . + -).");
        e.fixedIn = v;
      } else if (req.fixedIn !== undefined && req.fixedIn !== "") return no("fixedIn only goes with the fixed state.");
      if (req.commit !== undefined && req.commit !== "") {
        if (typeof req.commit !== "string" || !/^[0-9a-fA-F]{7,40}$/.test(req.commit.trim())) return no("commit must be a hex commit id of 7 to 40 characters.");
        e.commit = req.commit.trim();
      }
      if (req.note !== undefined && req.note !== "") {
        if (typeof req.note !== "string" || req.note.trim().length > 280) return no("note must be text of at most 280 characters.");
        e.note = req.note.trim();
      }
      next[tid] = e;
    }
    mkdirSync(seriesDir(), { recursive: true });
    writeJsonAtomic(s.triageFile, next, { space: 2, newline: true });
    return { ok: true };
  } catch (e) {
    return no(`Could not save the mark: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type AgentExposureStatus = "open" | "accepted" | "fixed";
export interface AgentExposureFinding {
  triageId: string; measure: string; subject: string; appVersion?: string; text: string; level: ExposureFinding["level"];
  status: AgentExposureStatus; triage?: ExposureTriage;
}

/**
 * What the agent route lists (`GET /api/agent/exposure`): the newest row for this dir after accepts and marks.
 * Default = OPEN findings only (a regression is open; accepted and fixed-and-hidden are not). `all` adds those with a
 * `status`, plus `staleMarks` (marks whose group is not in this reading). `dir` is the collector's recorded path.
 */
export function exposureFindingsFor(worktree: string, opts?: { all?: boolean }): { repo: string; dir: string; findings: AgentExposureFinding[]; staleMarks?: Array<{ triageId: string; triage: ExposureTriage }> } | null {
  const s = seriesFor(worktree);
  if (!s) return null;
  const tri = readTriage(s.triageFile);
  const acc = readAccepts(s.acceptsFile);
  const t = tri.ok ? tri.data : null;
  const eff = applyTriage(applyAccepts(s.row.findings ?? [], acc.ok ? acc.data : null, new Date()), t);
  const all = eff.map((f): AgentExposureFinding => ({
    triageId: exposureTriageId(f), measure: f.measure, subject: f.subject, ...(f.appVersion ? { appVersion: f.appVersion } : {}),
    text: f.text, level: f.level,
    status: f.accepted ? (f.accepted.byMark ? "fixed" : "accepted") : "open",
    ...(f.triage ? { triage: f.triage } : {}),
  }));
  const out = { repo: s.row.repo, dir: s.row.dir, findings: opts?.all ? all : all.filter((f) => f.status === "open") };
  if (!opts?.all) return out;
  const here = new Set((s.row.findings ?? []).map(exposureTriageId));
  const staleMarks = Object.entries(t ?? {}).filter(([id]) => !here.has(id)).map(([triageId, triage]) => ({ triageId, triage }));
  return { ...out, staleMarks };
}
