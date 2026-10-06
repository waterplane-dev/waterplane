import {
  type Lifecycle,
} from "@waterplane/shared";
import type { PullRecord } from "../pull";
import {
  act,
} from "./activityPieces.ts";
import {
  bucketOf,
} from "./activitySelect.ts";
import type { ActivityInput, ActivityRow } from "./activityTypes.ts";

// ── Download rows: bytes on their way to the phone ──────────────────────────

export function pullRow(p: PullRecord, input: ActivityInput): ActivityRow {
  const state: Lifecycle = p.state === "downloading" ? "running"
    : p.state === "done" ? "done"
    : p.state === "failed" ? "failed"
    : p.state === "paused" ? "blocked"
    : "queued";
  const pct = p.item.size ? Math.floor((p.received / p.item.size) * 100) : 0;
  // Rate in the same units the Downloads sheet uses: a 5 MB/s link reading
  // "5120 kB/s" is the same number told badly, and the two screens describe one
  // transfer.
  const rate = p.rate ? (p.rate >= 1e6 ? `${(p.rate / 1e6).toFixed(1)} MB/s` : p.rate >= 1e3 ? `${Math.round(p.rate / 1e3)} kB/s` : `${Math.round(p.rate)} B/s`) : null;
  const verdict = state === "running" ? `${pct}% — ${rate ?? "waiting for bytes"}`
    : state === "failed" ? (p.error || "the transfer stopped and nothing said why")
    : state === "blocked" ? "paused — it resumes from where it stopped"
    : state === "done" ? (p.savedTo ? (p.saveVia === "browser" ? `downloaded, handed to ${p.savedTo}` : `downloaded, saved to ${p.savedTo}`) : p.evicted ? "downloaded — the bytes were cleared to make room; fetching again is one tap" : "downloaded, on this phone")
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
    progress: { done: p.received, total: p.item.size, label: "bytes" },
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
