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
  PRE_ACCEPTED, cleanAcceptRequest, exposureKeyOf, exposureVersionStem, exposureChecks, readLastRow, semverCmp, EXPOSURE_SUMMARY_ID,
  type ComplianceAcceptRequest, type ComplianceCheck, type ExposureAccept, type ExposureRow,
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

interface Series { name: string; row: ExposureRow; acceptsFile: string }
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
      return { name, row, acceptsFile: join(dir, `${name}.accepted.json`) };
    }
  }
  return null;
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

/** The exposure rows for this worktree: none when no series names it. Never throws. */
export function exposureChecksFor(worktree: string): ComplianceCheck[] {
  try {
    const s = seriesFor(worktree);
    if (!s) return unreadableRow(worktree);
    const acc = readAccepts(s.acceptsFile);
    const rows = exposureChecks(s.row, s.name, acc.ok ? acc.data : null, new Date());
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
