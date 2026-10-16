import {
  type Lifecycle,
} from "@waterplane/shared";
import type { PullRecord } from "../pull";
import {
  act,
} from "./activityPieces.ts";
import {
  bucketOf,
} from "./activityBucket.ts";
import type { ActivityInput, ActivityRow } from "./activityTypes.ts";

// ── Download rows: bytes on their way to the phone ──────────────────────────

export function pullRow(p: PullRecord, input: ActivityInput): ActivityRow {
  const state: Lifecycle = p.state === "downloading" ? "running"
    : p.state === "done" ? "done"
    : p.state === "failed" ? "failed"
    : p.state === "paused" ? "blocked"
    : "queued";
  const pct = p.item.size ? Math.floor((p.received / p.item.size) * 100) : 0;
  const rate = p.rate ? `${bytes(Math.round(p.rate))}/s` : null;
  // Done, the size is said HERE, once: a full bar and "31 kB of 31 kB" under it said it twice more.
  const got = `downloaded${p.item.size ? ` · ${bytes(p.item.size)}` : ""}`;
  const verdict = state === "running" ? `${pct}% — ${rate ?? "waiting for bytes"}`
    : state === "failed" ? (p.error || "the transfer stopped and nothing said why")
    : state === "blocked" ? "paused — it resumes from where it stopped"
    : state === "done" ? (p.savedTo ? `${got} · ${p.saveVia === "browser" ? "handed to" : "saved to"} ${p.savedTo}` : p.evicted ? `${got} — the bytes were cleared to make room; fetching again is one tap` : `${got} · on this phone`)
    : pct > 0 ? `queued — ${pct}% already here from an earlier attempt` : "queued";
  return {
    key: `pull:${p.item.id}`,
    id: p.item.id,
    source: "pull",
    kind: "download",
    state,
    bucket: bucketOf(state, null),
    // A paused transfer is not "not due yet" — it is waiting, and it resumes on
    // its own. None of the ten shared reasons is about a byte stream, so `null`
    // stands and the verdict carries the whole answer.
    blockReason: null,
    verdict,
    title: p.item.name,
    clipped: false,
    fullText: null,
    // A download IS a file, and this row already draws its name, its progress
    // and where it was saved. A strip here would be the same file said twice,
    // at the cost of a second listing per row.
    attachText: null,
    where: p.item.repoName || input.deps.repoName(p.item.repoDir),
    cwd: p.item.repoDir,
    sessionId: null,
    delivery: null,
    at: p.updatedAt,
    createdAt: p.item.ts,
    dueAt: p.nextRetryAt ?? null,
    // Local: the record lives in this phone's IndexedDB, so it is never a
    // stale copy of something the host knows better.
    asOf: null,
    // The bar is for a transfer in the MIDDLE (running, or paused part-way). Done, its size is
    // in the verdict; queued, the verdict already says how much an earlier attempt left.
    progress: state === "running" || state === "blocked" ? { done: p.received, total: p.item.size, label: "bytes" } : null,
    targets: [],
    lastRun: null,
    attempts: p.attempts,
    actions: [
      act("save", "save to phone", {
        primary: state === "done" && !p.evicted,
        disabledReason: state === "done" && !p.evicted ? undefined : "there is nothing downloaded to save yet",
      }),
      act("retry", state === "failed" ? "try again" : "fetch it now", {
        // Same reason as the build row above: the transfer needs the host's
        // bytes, not the socket, and a tap on a dead link is a queued download
        // rather than a refusal. What it CANNOT do is fetch something already
        // here — `pulls.retry` no-ops on that, so offering it was a button that
        // did nothing and a toast that said it had.
        primary: state !== "done",
        disabledReason: state === "running" ? "it is downloading"
          : state === "done" && !p.evicted ? "it is already on this phone — save it out instead"
          : undefined,
      }),
      act("discard", "drop it", { danger: true, alwaysShown: true }),
    ],
    subject: { source: "pull", record: p },
  };
}

/** The Downloads sheet's units, rate included: a 5 MB/s link reading "5120 kB/s" is the same
 *  number told badly, and the two screens describe one transfer. */
export const bytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);
