import { LS, lsGet, lsSetJson } from "./storage";
// Read/download marks for artifacts — "is this outbox drop new, or did I already
// look at it?".
//
// An outbox is a stream of agent-produced reports and screenshots, and the grid
// sorts newest-first with no state at all: coming back to it, every file looks
// identical whether you read it an hour ago or it landed while you were away.
// This is the per-device watermark that answers that, the same shape as the
// reader view's `waterplane.trSeen.<sessionId>`: purely local, instant, no host round
// trip and no wire change.
//
// Three states: `new` (never opened here), `opened` (rendered in the viewer),
// `downloaded` (saved to the device — strictly stronger, so it wins).
//
// Keyed by repo + repo-relative path, VALIDATED against mtime: an agent that
// regenerates `report.md` in place writes a genuinely new file at the same path,
// and reporting it as already-read is the one wrong answer here. A changed mtime
// resets the entry to `new`.

export type ArtifactMark = "new" | "opened" | "downloaded";

const KEY = LS.artMarks;
/** Entries kept. A busy outbox produces files forever; the oldest marks are the
 *  least useful (those files have long scrolled out of every time window). */
const MAX = 3000;

interface Entry {
  /** mtime of the file when it was marked — a different one means it changed. */
  t: number;
  /** ms timestamps; presence is the flag. */
  o?: number;
  d?: number;
}

let cache: Record<string, Entry> | null = null;

function load(): Record<string, Entry> {
  if (cache) return cache;
  try {
    const raw = lsGet(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    cache = parsed && typeof parsed === "object" && parsed.m && typeof parsed.m === "object" ? parsed.m : {};
  } catch {
    cache = {};
  }
  return cache!;
}

function save(m: Record<string, Entry>) {
  const keys = Object.keys(m);
  if (keys.length > MAX) {
    // Drop the oldest touches first (download beats open — a downloaded file is
    // the one you're most likely to come back looking for).
    const touched = (e: Entry) => Math.max(e.d ?? 0, e.o ?? 0);
    keys.sort((a, b) => touched(m[a]) - touched(m[b]));
    for (const k of keys.slice(0, keys.length - MAX)) delete m[k];
  }
  // Quota/private mode — marks are a nicety, never an error path (lsSetJson swallows both).
  lsSetJson(KEY, { v: 1, m });
}

const keyOf = (repoId: string, relPath: string) => `${repoId}:${relPath}`;

/** Current mark for a file. `mtime` is the file's CURRENT mtime — a mark taken
 *  against a different one is stale and reads as `new`. */
export function artifactMark(repoId: string, relPath: string, mtime: number): ArtifactMark {
  const e = load()[keyOf(repoId, relPath)];
  if (!e || e.t !== mtime) return "new";
  if (e.d) return "downloaded";
  if (e.o) return "opened";
  return "new";
}

function mark(repoId: string, relPath: string, mtime: number, field: "o" | "d") {
  const m = load();
  const k = keyOf(repoId, relPath);
  const prev = m[k];
  const e: Entry = prev && prev.t === mtime ? prev : { t: mtime };
  e[field] = Date.now();
  m[k] = e;
  save(m);
}

/** Opened in the in-app viewer (rendered/read here). */
export function markArtifactOpened(repoId: string, relPath: string, mtime: number) {
  mark(repoId, relPath, mtime, "o");
}
/** The bytes reached this phone. Written when a download FINISHES (`download.ts`),
 *  never on the tap: a transfer that fails must not leave the grid claiming the
 *  file was downloaded. Implies opened. */
export function markArtifactDownloaded(repoId: string, relPath: string, mtime: number) {
  mark(repoId, relPath, mtime, "d");
}
