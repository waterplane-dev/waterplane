/**
 * The manager's helpers: anchors, the per-worktree lease, the sidecar reader and
 * the intent → run rendering. Split out of `capture.ts` (move only).
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  BuildArtifact, CaptureRun, CaptureRunStatus, CaptureSidecar, CaptureVerification, Intent,
} from "@waterplane/shared";
import { contained } from "../paths.js";
import { targetId as repoIdOf } from "../repos.js";
import type { OracleReading } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// The manager.
// ─────────────────────────────────────────────────────────────────────────────

/** Anchors, matched against whatever the oracle handed back. */
export function matchAnchors(wanted: string[], r: OracleReading): { found: string[]; missing: string[] } {
  if (r.found || r.missing) {
    // The oracle did the matching itself (ciqkit's OCR). Its verdict wins.
    const found = r.found ?? [];
    return { found, missing: r.missing ?? wanted.filter((a) => !found.includes(a)) };
  }
  const hay = (r.text ?? "").toLowerCase();
  const found = wanted.filter((a) => hay.includes(a.toLowerCase()));
  return { found, missing: wanted.filter((a) => !found.includes(a)) };
}

/** A reading only counts as "somebody was asked" when there is something in it
 *  to match against. A web page whose `innerText` could not be read is not an
 *  oracle that answered. */
export function oracleAnswered(r: OracleReading | null): r is OracleReading {
  return !!r && (r.found !== undefined || r.missing !== undefined || typeof r.text === "string");
}

/** A target id is a filename component here. Anything that is not is dropped —
 *  `newOutboxPath` joins this onto the outbox dir, and a `..` in it would be a
 *  traversal. */
export function safeId(id: string): string {
  const s = id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s || "target";
}

export function artifactOf(repoDir: string, out: { full: string; relPath: string; name: string }): BuildArtifact {
  let size = 0, mtime = Date.now();
  try { const st = statSync(out.full); size = st.size; mtime = st.mtimeMs; } catch { /* just written */ }
  return { repoId: repoIdOf(repoDir), name: out.name, relPath: out.relPath, size, mtime };
}

/**
 * In-process leases. `web:<port>`, `android:<serial>`, `window:host` — two runs
 * against one browser port or one desktop would photograph each other's state.
 *
 * `garmin` passes null and takes NONE: ciqkit runs its own broker with its own
 * queue, and a second lease held on this side would deadlock against it the
 * moment anything else on the machine submitted a job.
 */
const leases = new Map<string, Promise<unknown>>();

export async function withLease<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const prev = leases.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => mine, () => mine);
  leases.set(key, tail);
  await prev.catch(() => { /* a predecessor's failure is not ours */ });
  try {
    return await fn();
  } finally {
    release();
    if (leases.get(key) === tail) leases.delete(key);
  }
}

/** Sidecars already read, keyed by path+mtime — `runsFor()` is called on every
 *  sheet open and a run list must not re-read forty JSON files per tap. */
const sidecarCache = new Map<string, { mtime: number; doc: CaptureSidecar }>();

function readSidecar(repoDir: string, relPath: string): CaptureSidecar | null {
  const full = contained(resolve(repoDir), relPath);
  if (!full) return null;
  try {
    const st = statSync(full);
    const hit = sidecarCache.get(full);
    if (hit && hit.mtime === st.mtimeMs) return hit.doc;
    const doc = JSON.parse(readFileSync(full, "utf8")) as CaptureSidecar;
    if (!doc || doc.v !== 1) return null;
    sidecarCache.set(full, { mtime: st.mtimeMs, doc });
    return doc;
  } catch {
    return null;
  }
}

/**
 * An intent row, as the run row a sheet renders.
 *
 * The verdict fields come out of the SIDECAR rather than being carried on the
 * intent: the sidecar is the evidence record, it is already on disk, and
 * copying its summary into the store would give one run two places to disagree
 * about what it found. An unreadable sidecar leaves them absent and the row
 * falls back to the executor's own sentence, which is the same degradation
 * every other field here makes.
 */
export function intentToCaptureRun(i: Intent): CaptureRun {
  const p = i.payload.kind === "capture" ? i.payload : null;
  // Every non-terminal lifecycle collapses to `running`, and `startedAt` falls
  // back to `createdAt`, so a row that is only ARMED — `queued`, `blocked`, or
  // a capture posted on an `at` trigger — renders with a spinner and a climbing
  // duration. That is knowingly kept: `CaptureRunStatus` is `BuildRunStatus`'s
  // set on purpose (one lifecycle, one vocabulary), a fifth value is a wire
  // change every reader must learn, and nothing the shipped sheet can do posts
  // a capture that is not `trigger: now`. If a scheduled capture ever becomes
  // reachable from the UI, the honest fix is the new status and an optional
  // `startedAt` — not a different guess here.
  const status: CaptureRunStatus =
    i.state === "done" ? "done"
      : i.state === "canceled" ? "cancelled"
        : i.state === "failed" ? "failed"
          : "running";
  const artifacts = i.result?.artifacts;
  const sidecarRelPath = artifacts?.find((a) => a.relPath.toLowerCase().endsWith(".json"))?.relPath;
  const doc = sidecarRelPath ? readSidecar(i.cwd, sidecarRelPath) : null;
  return {
    runId: i.id,
    repoDir: i.cwd,
    targetId: p?.targetId ?? doc?.target.id ?? "",
    name: p?.name || doc?.target.name || i.title || "capture",
    // The payload's backend is dropped by the shared sanitizer when it is not a
    // known id, so a hand-edited row can arrive without one — and a run that is
    // still going, or that failed before it wrote a sidecar, has no sidecar to
    // ask either. Then NOBODY recorded which backend this was, and the field is
    // ABSENT. It used to fall back to `window`, which is the one value that is
    // actively false: `window` means "a grab of the whole desktop", so the row
    // asserted a fact about a run it could not account for.
    backend: p?.backend ?? doc?.target.backend,
    // Only an explicit `true`. A payload that does not say is a row nobody
    // recorded this for, and `false` would say "this is an ordinary capture"
    // about a watch run that is legitimately still going ten minutes later.
    watch: p?.watch === true ? true : undefined,
    status,
    verification: doc?.verification,
    score: doc?.score,
    verdict: doc?.verdict ?? (status === "running" ? undefined : i.result?.detail),
    sidecarRelPath,
    files: artifacts,
    startedAt: i.startedAt ?? i.createdAt,
    finishedAt: i.settledAt,
    exitCode: i.result?.exitCode ?? null,
  };
}


/** The weaker of two levels — a run claims what its worst frame can support. */
export function weakest(a: CaptureVerification, b: CaptureVerification): CaptureVerification {
  const rank = { unverified: 0, stable: 1, anchor: 2 };
  return rank[a] <= rank[b] ? a : b;
}
