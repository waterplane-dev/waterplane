/**
 * SETTLE — sample until two consecutive frames agree. Split out of `capture.ts`
 * (move only); the clock rule below is the one that was re-broken once.
 */
import { join } from "node:path";
import { SETTLE_SAMPLE_MS, sleep } from "./capturekit.js";
import { framesIdentical } from "./pixels.js";
import type { CaptureCtx, CaptureSession } from "./types.js";

/**
 * SETTLE — sample until two consecutive frames are byte-identical, or until the
 * cap.
 *
 * Byte-equality and not a pixel comparison, deliberately: it needs no tool at
 * all, which is what lets a machine with no ImageMagick still reach
 * `settled:stable`. `settleMs` is a CAP — the loop stops the moment the screen
 * agrees with itself, and a screen that never does gets its frame anyway with
 * `stableAfterMs` ABSENT and a level that says `unverified`.
 *
 * ── The clock starts when the FIRST FRAME COMPLETES ────────────────────────
 *
 * `settleMs` is "how long to wait for the screen to stop moving", NOT "how long
 * one frame may take". Those are different quantities and conflating them broke
 * the whole loop on any slow backend: a cold garmin frame costs ~80–87 s (the
 * simulator is pushed and restarted), the default cap is 15 s, so a clock
 * started before frame 1 was already past the cap when frame 1 came back. The
 * loop broke at `sampled: 1`, which is `unverified` on every backend — and
 * `verificationLevel()` then THREW AWAY an OCR-confirmed anchor, because
 * `anchor` requires `settled` and one frame can never be settled. Every real
 * ciqkit run was `unverified`, with an anchor record beside it saying the text
 * was there.
 *
 * So: the first frame is paid for unconditionally, whatever it costs, and the
 * cap governs the WAITING after it. This is the kind of thing that gets
 * re-broken by somebody making the run "respect its timeout".
 */
export async function settleFrames(
  session: CaptureSession,
  ctx: CaptureCtx,
  capMs: number,
  tag: string,
): Promise<{ last: string; sampled: number; stableAfterMs?: number; score?: number; note?: string }> {
  let t0 = 0;
  let prev: string | null = null;
  let last = "";
  let sampled = 0;
  let stableAfterMs: number | undefined;
  let score: number | undefined;
  let note: string | undefined;

  for (;;) {
    const r = await session.frame(join(ctx.tmpDir, `${tag}-${sampled}.png`));
    sampled++;
    if (sampled === 1) t0 = Date.now();
    last = r.path;
    if (r.score !== undefined) score = r.score;
    if (r.note) note = r.note;
    if (prev && framesIdentical(prev, last)) { stableAfterMs = Date.now() - t0; break; }
    prev = last;
    if (ctx.cancelled()) break;
    if (Date.now() - t0 >= capMs) break;
    await sleep(SETTLE_SAMPLE_MS);
  }

  // Score the frame that is actually kept, once. A backend whose scorer is a
  // subprocess (ciqkit shells out to python and numpy) must not pay for one per
  // sample: the samples before the last one are thrown away, so their scores
  // are a number nobody reads bought at a process start each. A backend that
  // knows the score first-hand still returns it on `FrameResult` and that
  // answer stands.
  if (session.score && last) {
    const s = await session.score(last);
    if (s !== null) score = s;
  }
  return { last, sampled, stableAfterMs, score, note };
}
