/**
 * One capture run's passes: verify → settle → diff → emit, the frame writer and
 * the watch loop. Split out of `CaptureManager` (move only): the three private
 * methods are functions now, and the manager's `canceled` set is handed in.
 */
import { writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BuildArtifact, CaptureFile, CaptureSidecar, CaptureTarget, CaptureTheme, CaptureVerification,
  CaptureViewport, Intent,
} from "@waterplane/shared";
import { newOutboxPath } from "../files.js";
import type { CaptureBackend, CaptureCtx, CapturePass, CaptureSession } from "./types.js";
import { blankVariance, changedPct, pixelToolReason, pngSize, probePixelTools, BLANK_SD } from "./pixels.js";
import {
  DEFAULT_DIFF_PCT, DEFAULT_SETTLE_MS, MAX_SETTLE_MS, MAX_SIDECAR_LINES, WATCH_INTERVAL_MS, WATCH_MAX_FRAMES, WATCH_MAX_MS, sleep,
} from "./capturekit.js";
import { classifyOverlay } from "./captureconfig.js";
import { diffRecord, shouldEmit, verdictLine, verificationLevel } from "./captureverdict.js";
import { artifactOf, matchAnchors, oracleAnswered, safeId, weakest } from "./capturehelpers.js";
import { settleFrames } from "./capturesettle.js";

/**
 * What a run settles with — the part of the intent store's `ExecutorResult` this
 * file produces. Declared here because `capture/` is a leaf (it never imports
 * `intents/`); the manager's `execute` returns it as an `ExecutorResult` and the
 * type checker holds the two together.
 */
export interface CapturePassResult {
  ok: boolean;
  detail: string;
  canceled?: boolean;
  exitCode?: number | null;
  artifacts?: BuildArtifact[];
}

/** verify → settle → diff → emit, once per pass. */
export async function runCapturePass(
  canceledSet: ReadonlySet<string>,
  i: Intent,
  target: CaptureTarget,
  backend: CaptureBackend,
  cwd: string,
  tmpDir: string,
  watch: boolean,
  log: (l: string) => void,
): Promise<CapturePassResult> {
  const runId = i.id;
  const startedAt = Date.now();
  const anchors = target.anchor ?? [];
  const settleCap = Math.min(target.settleMs ?? DEFAULT_SETTLE_MS, MAX_SETTLE_MS);
  const diffPct = target.diffPct ?? DEFAULT_DIFF_PCT;
  const passes = backend.passes(target);

  const files: CaptureFile[] = [];
  const artifacts: BuildArtifact[] = [];
  let sampled = 0;
  let stableAfterMs: number | undefined;
  let level: CaptureVerification | undefined;
  let overlay: CaptureSidecar["errorOverlay"];
  let diffRec: CaptureSidecar["diff"];
  let score: number | undefined;
  let viewport: CaptureViewport | undefined;
  let theme: CaptureTheme | undefined;
  let blank = false;

  // ── Aggregated across passes, never overwritten by the last one ──────────
  //
  // A `theme: "both"` target is two passes, and the sidecar is ONE record of
  // the run. Keeping only the newest pass's console made a dark pass that
  // logged three errors disappear behind a clean light one, and rewrote an
  // anchor record whose own level said the anchor was missing. The rule below
  // is the same one `weakest()` applies to the level: the run is only as
  // trustworthy as its weakest frame, so counts SUM, missing anchors UNION,
  // and a found anchor has to have been found by every pass that looked.
  const consoleAcc = { errors: 0, warnings: 0, lines: [] as string[] };
  const netAcc = { failed: 0, lines: [] as string[] };
  let sawConsole = false;
  let sawNetwork = false;
  let sawAnchors = false;
  let anchorFound: string[] = [];
  const anchorMissing = new Set<string>();
  /** Distinct geometry+theme combinations, so the verdict can admit there
   *  were others rather than quoting one pass's shape as the run's. */
  const shapes = new Set<string>();

  for (let n = 0; n < passes.length; n++) {
    const pass = passes[n];
    if (canceledSet.has(runId)) break;
    const ctx: CaptureCtx = {
      cwd, tmpDir, pass, anchors, log,
      cancelled: () => canceledSet.has(runId),
    };
    const session = await backend.open(target, ctx);
    try {
      const settle = await settleFrames(session, ctx, settleCap, `p${n}`);
      sampled += settle.sampled;
      if (settle.stableAfterMs !== undefined) {
        stableAfterMs = Math.max(stableAfterMs ?? 0, settle.stableAfterMs);
      }
      // The weakest pass's score, not the newest — same rule as the level. A
      // run is not worth its best-looking frame.
      if (settle.score !== undefined) score = score === undefined ? settle.score : Math.min(score, settle.score);
      if (settle.note) log(`[capture] ${settle.note}`);

      const reading = await session.oracle();
      const asked = oracleAnswered(reading);
      const m = asked && anchors.length ? matchAnchors(anchors, reading) : null;
      if (m) {
        // Intersect the found, union the missing. An anchor one pass saw and
        // another did not is a MISSING anchor for the run — the old code let
        // a later pass rewrite `missing` to `[]` under a level that had
        // already been capped by the earlier one, so the evidence and the
        // claim contradicted each other inside one document.
        anchorFound = sawAnchors ? anchorFound.filter((a) => m.found.includes(a)) : m.found.slice();
        for (const a of m.missing) anchorMissing.add(a);
        sawAnchors = true;
      }
      if (reading?.console) {
        sawConsole = true;
        consoleAcc.errors += reading.console.errors;
        consoleAcc.warnings += reading.console.warnings;
        for (const l of reading.console.lines) if (consoleAcc.lines.length < MAX_SIDECAR_LINES) consoleAcc.lines.push(l);
      }
      if (reading?.network) {
        sawNetwork = true;
        netAcc.failed += reading.network.failed;
        for (const l of reading.network.lines) if (netAcc.lines.length < MAX_SIDECAR_LINES) netAcc.lines.push(l);
      }
      const ov = reading?.overlay ?? classifyOverlay(reading?.html);
      if (ov && !overlay) overlay = ov;

      const passLevel = verificationLevel({
        sampled: settle.sampled,
        settled: settle.stableAfterMs !== undefined,
        oracle: asked,
        wanted: anchors.length,
        // THIS pass's misses — the run-wide union is the record, not the rung.
        missing: m ? m.missing.length : anchors.length,
      });
      // The run is only as trustworthy as its weakest frame.
      level = level === undefined ? passLevel : weakest(level, passLevel);

      const sd = await blankVariance(settle.last);
      if (sd !== null && sd < BLANK_SD) blank = true;

      // `pass.viewport` is what was ASKED for in device-independent pixels;
      // `size` is the PNG's own device pixels, which is the only geometry a
      // backend that emulates nothing has. They are different numbers on a
      // web pass (`deviceScaleFactor: 2`) and `wire/capture.ts` says which is
      // which. The FIRST pass's is recorded — `shapes` is what says the rest
      // existed, and `files[]` carries each frame's own.
      const size = pngSize(settle.last);
      const geom = pass.viewport ?? size ?? undefined;
      shapes.add(`${geom ? `${geom.w}x${geom.h}` : "n/a"}|${pass.theme ?? ""}`);
      if (viewport === undefined) viewport = geom;
      if (theme === undefined && pass.theme) theme = pass.theme;

      const emitted = emitFrame(i.cwd, target, settle.last, pass, size, files, artifacts);
      log(`[capture] ${pass.label || "frame"} → ${emitted.relPath} (${settle.sampled} sampled`
        + `${settle.stableAfterMs !== undefined ? `, settled after ${settle.stableAfterMs} ms` : ", never settled"})`);

      if (watch && n === 0) {
        const w = await watchLoop(i, target, session, ctx, emitted, diffPct, files, artifacts, log);
        diffRec = w.diff;
        sampled += w.sampled;
      }
    } finally {
      try { await session.end(); } catch { /* already gone */ }
    }
    if (watch) break;   // watch drives ONE pass; the rest would fight it for the lease
  }

  const canceled = canceledSet.has(runId);
  const verification = level ?? "unverified";
  // Absent stays absent: a run where no pass had a console to read carries no
  // console record at all, which prints `n/a` and is a different statement
  // from a measured `{errors: 0}`.
  const consoleRec: CaptureSidecar["console"] = sawConsole ? consoleAcc : undefined;
  const netRec: CaptureSidecar["network"] = sawNetwork ? netAcc : undefined;
  const anchorRec: CaptureSidecar["anchor"] = sawAnchors
    ? { wanted: anchors, found: anchorFound.filter((a) => !anchorMissing.has(a)), missing: [...anchorMissing] }
    : undefined;
  const verdict = verdictLine({
    verification, blank, errorOverlay: overlay, score, viewport, theme,
    shapes: shapes.size, console: consoleRec, network: netRec,
  });

  const sidecar: CaptureSidecar = {
    v: 1,
    runId,
    target: { id: target.id, name: target.name, backend: target.backend },
    startedAt,
    finishedAt: Date.now(),
    verification,
    anchor: anchorRec,
    score,
    viewport,
    theme,
    frames: { sampled, stableAfterMs },
    errorOverlay: overlay,
    console: consoleRec,
    network: netRec,
    diff: diffRec,
    files,
    verdict,
  };
  const doc = newOutboxPath(i.cwd, `capture-${safeId(target.id)}`, ".json");
  try {
    writeFileSync(doc.full, JSON.stringify(sidecar, null, 2));
    artifacts.push(artifactOf(i.cwd, doc));
    log(`[capture] ${doc.relPath}`);
  } catch (e) {
    log(`[capture] could not write the sidecar: ${String((e as Error)?.message ?? e)}`);
  }
  log(`[capture] ${verdict}`);

  if (canceled) return { ok: false, canceled: true, detail: "cancelled from the phone", artifacts, exitCode: null };
  // An overlay or a blank frame is a FAILED run with a verdict — and the
  // frame is in the outbox either way, because a failure whose evidence was
  // deleted cannot be debugged from a phone.
  const ok = !overlay && !blank && files.length > 0;
  return {
    ok,
    detail: verdict,
    exitCode: ok ? 0 : 1,
    artifacts,
  };
}

/** Copy one settled frame into `.claude/outbox/` and record it both ways. */
function emitFrame(
  repoDir: string,
  target: CaptureTarget,
  from: string,
  pass: CapturePass,
  size: CaptureViewport | null,
  files: CaptureFile[],
  artifacts: BuildArtifact[],
): { relPath: string; full: string } {
  const out = newOutboxPath(repoDir, `capture-${safeId(target.id)}`, ".png");
  copyFileSync(from, out.full);
  files.push({ relPath: out.relPath, w: size?.w, h: size?.h, theme: pass.theme });
  artifacts.push(artifactOf(repoDir, out));
  return { relPath: out.relPath, full: out.full };
}

/**
 * Watch mode: keep sampling one pass, emitting only what the diff gate lets
 * through, until cancel / 10 minutes / 60 frames.
 *
 * With no pixel tool `shouldEmit` degrades to emit-every-frame, and the
 * REASON it gives is logged and stored on `diff.reason` — so the output says
 * why sixty near-identical frames appeared, rather than the run looking
 * broken or, worse, silently emitting nothing.
 */
async function watchLoop(
  i: Intent,
  target: CaptureTarget,
  session: CaptureSession,
  ctx: CaptureCtx,
  firstEmitted: { relPath: string; full: string },
  diffPct: number,
  files: CaptureFile[],
  artifacts: BuildArtifact[],
  log: (l: string) => void,
): Promise<{ diff?: CaptureSidecar["diff"]; sampled: number }> {
  const tools = await probePixelTools();
  const t0 = Date.now();
  let emitted = 1;
  let skipped = 0;
  let sampled = 0;
  let against = firstEmitted;
  let diff: CaptureSidecar["diff"] | undefined;

  log(`[capture] watching — a frame is kept past ${diffPct}% changed, up to ${WATCH_MAX_FRAMES} frames or 10 minutes.`);
  while (!ctx.cancelled() && Date.now() - t0 < WATCH_MAX_MS && emitted < WATCH_MAX_FRAMES) {
    await sleep(WATCH_INTERVAL_MS);
    if (ctx.cancelled()) break;
    const path = join(ctx.tmpDir, `watch-${sampled}.png`);
    let taken: string;
    try { taken = (await session.frame(path)).path; } catch (e) { log(`[capture] ${String((e as Error)?.message ?? e)}`); break; }
    sampled++;

    const pct = await changedPct(against.full, taken);
    const d = shouldEmit({ first: false, changedPct: pct, diffPct, emitted, maxFrames: WATCH_MAX_FRAMES });
    if (!d.emit) { skipped++; continue; }

    const size = pngSize(taken);
    const out = emitFrame(i.cwd, target, taken, ctx.pass, size, files, artifacts);
    emitted++;
    diff = diffRecord(against.relPath, pct, pixelToolReason(tools));
    log(`[capture] ${out.relPath} — ${d.reason}`);
    against = out;
  }
  log(`[capture] watch ended: ${emitted} frames kept, ${skipped} skipped.`);
  return { diff, sampled };
}
