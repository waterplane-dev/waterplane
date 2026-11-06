/**
 * The readings as the charts DRAW them: held from one to the next, stepping at each.
 *
 * Its own slice, imported directly: not re-exported by the `contextPlot.ts` facade, whose surface
 * is pinned (`plotpins.test.mjs`).
 *
 * A conversation's window and its running total move only at a request, so a straight line between
 * two readings claims a slide that never happened. Over a fan-out that is hours: with the parent
 * silent from 13:12 to 15:17, a compaction at 14:07 was drawn as two hours of the window draining.
 * The agents' own times keep such a stretch on the axis, so no break hides it.
 *
 * These are points for paths only. The scrub, the totals and the legends keep the real readings.
 */
import type { AgentRun, ContextEvent, ContextSample, SampleKinds } from "@waterplane/shared";

/** The last moment any agent wrote: the axis runs there, and the parent's reading still stands. */
export function agentsEnd(agents: AgentRun[] | undefined): number | undefined {
  return agents?.length ? Math.max(...agents.map((a) => a.endAt)) : undefined;
}

/** A reading after a compaction: the measured size, the split in the shares it had before. */
function compacted(s: ContextSample, t: number, postTok: number): ContextSample {
  const k = s.tok > 0 ? postTok / s.tok : 0;
  return { ...s, t, tok: postTok, ...(s.kinds ? { kinds: s.kinds.map((v) => v * k) as SampleKinds } : {}) };
}

/**
 * `events` steps the window down at each compaction that measured its size; one that did not
 * changes nothing here, and the fall waits for the next reading. `until` carries the last reading
 * on to that instant. Empty in, empty out.
 */
export function heldSamples(samples: ContextSample[], events: ContextEvent[], until?: number): ContextSample[] {
  const drops = events
    .filter((e) => e.kind === "compact" && e.postTok != null)
    .sort((a, b) => a.t - b.t);
  const out: ContextSample[] = [];
  samples.forEach((s, i) => {
    const end = samples[i + 1]?.t ?? until ?? s.t;
    let at = s;
    out.push(s);
    for (const e of drops) {
      if (e.t <= s.t || e.t >= end) continue;
      out.push({ ...at, t: e.t });
      at = compacted(at, e.t, e.postTok!);
      out.push(at);
    }
    if (end > at.t) out.push({ ...at, t: end });
  });
  return out;
}
