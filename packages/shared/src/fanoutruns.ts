/**
 * **A sweep, rebuilt from the rows that make it up.**
 *
 * A fan-out used to be an in-memory ring host-side that died with the daemon —
 * the run record, not the sessions, which is why a restart mid-sweep left twelve
 * sessions and no account of what they were for. It is now N intents sharing a
 * `groupId`, so the run is exactly as durable as everything else in the store
 * and `finishedAt` is DERIVED: a run is over when nothing in its group is still
 * going, which is also what makes a follow-up correctly reopen it.
 *
 * ── Why it is HERE and not in `host/intents/adapters.ts` ────────────────────
 *
 * It was there, and that was right while the host was the only reader of an
 * `Intent`. The phone is one now, and the alternative to moving this was for
 * the phone to keep taking the aggregate over the wire as a `FanoutRun` DTO —
 * which is the pattern this whole change exists to stop: a lossy per-vocabulary
 * projection, sent alongside the rows it was projected FROM, in the same frame
 * burst, over the one link this app spends its life apologising for.
 *
 * The function did not become shared code by being duplicated. It moved. The
 * host imports it from here and its own call sites are unchanged.
 */
import { FANOUT_MAX_RUNS, type FanoutRun, type FanoutStatus } from "./wire/work.js";
import { ORIGIN_FANOUT_FOLLOWUP, ORIGIN_FANOUT_TARGET, isFanoutRow, type Intent } from "./intent.js";

/** The one place an intent's lifecycle becomes a sweep target's status. */
const fanoutStatus = (i: Intent): FanoutStatus =>
  i.state === "done" ? "done"
    : i.state === "failed" || i.state === "canceled" ? "failed"
      : i.state === "running" ? "running"
        : i.state === "starting" ? "starting"
          : "pending";

/** Last path segment. `node:path`'s `basename` is not available on the phone,
 *  and a sweep target's label is the only thing this needed it for. */
const lastSegment = (p: string): string => p.split("/").filter(Boolean).pop() || p;

export function fanoutRuns(all: readonly Intent[], cap = FANOUT_MAX_RUNS): FanoutRun[] {
  const groups = new Map<string, Intent[]>();
  for (const i of all) {
    if (!isFanoutRow(i)) continue;
    const g = groups.get(i.groupId!) ?? [];
    g.push(i);
    groups.set(i.groupId!, g);
  }
  const runs: FanoutRun[] = [];
  for (const [runId, rows] of groups) {
    const parent = all.find((r) => r.id === runId);
    const targets = rows.filter((r) => r.origin === ORIGIN_FANOUT_TARGET)
      .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
    if (!targets.length && !parent) continue;
    const text = (parent?.payload.kind === "prompt" ? parent.payload.steps[0] : undefined)
      ?? (targets[0]?.payload.kind === "prompt" ? targets[0].payload.steps[0] : "");
    const startedAt = parent?.createdAt ?? Math.min(...targets.map((t) => t.createdAt));
    const settled = (r: Intent) => r.state === "done" || r.state === "failed" || r.state === "canceled";
    const open = rows.some((r) => !settled(r));
    // Follow-ups are grouped by their batch: one tap addressed one subset, and
    // the run records that subset, not N separate sends.
    const batches = new Map<string, Intent[]>();
    for (const r of rows) {
      if (!r.origin?.startsWith(ORIGIN_FANOUT_FOLLOWUP)) continue;
      const key = r.origin.slice(ORIGIN_FANOUT_FOLLOWUP.length);
      batches.set(key, [...(batches.get(key) ?? []), r]);
    }
    const followUps = [...batches.values()]
      .map((b) => ({
        text: b[0].payload.kind === "prompt" ? b[0].payload.steps[0] : "",
        at: Math.min(...b.map((r) => r.createdAt)),
        dirs: b.map((r) => r.cwd),
      }))
      .sort((a, b) => a.at - b.at);
    runs.push({
      id: runId,
      text,
      startedAt,
      finishedAt: open ? undefined : Math.max(...rows.map((r) => r.settledAt ?? r.createdAt)),
      targets: targets.map((t) => ({
        dir: t.cwd,
        title: t.title || lastSegment(t.cwd),
        sessionId: t.sessionId,
        status: fanoutStatus(t),
        error: t.state === "failed" || t.state === "canceled" ? t.result?.detail : undefined,
      })),
      followUps: followUps.length ? followUps : undefined,
    });
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, cap);
}
