/**
 * The verified capture loop — "show me what that screen looks like right now,
 * and say how much the picture can be trusted".
 *
 * A capture is a BUILD with a picture at the end of it, and this file is
 * `builds.ts` with one extra half bolted on. The targets live per repo in
 * `<repoDir>/<state dir>/capture.json`, the sibling of `builds.json`; a run IS an
 * intent (so `runId` is the intent id, the row is on disk before the tap
 * returns, and a restart accounts for it); the frames land in `.claude/outbox/`
 * through the same `newOutboxPath` every other artifact uses, which is why they
 * flow through the gallery, the badge, thumbnails and the download button with
 * no new plumbing at either end.
 *
 * The extra half is the CLAIM. Everything below exists to keep one rule:
 *
 * ── verify → settle → diff → emit ──────────────────────────────────────────
 *
 *   VERIFY — ask the running thing what is on its screen (`oracle()`). The word
 *     "verified" is reserved for that reading: `verified:anchor` and nothing
 *     else. A backend with no oracle — `capture/window.ts`, a grab of somebody
 *     else's window — can never reach it, however good the picture is.
 *   SETTLE — sample until two consecutive frames agree. `settleMs` is a CAP on
 *     how long that is worth waiting, NEVER a sleep: a fixed sleep is both too
 *     long for a static page and too short for a slow one, and it produces a
 *     frame nobody can say anything about. One frame with nothing to compare it
 *     against is `unverified`, on every backend.
 *   DIFF — in watch mode, a new frame is only worth a FILE if it differs. This
 *     is token hygiene, not disk hygiene: every frame in the outbox is a frame
 *     an agent may be handed on some later turn, and 60 near-identical
 *     screenshots of one screen is a context bill nobody chose to pay.
 *   EMIT — write the PNG and the sidecar. Including for a FAILED run: a frame
 *     of a red error overlay is the failure's evidence, and deleting it leaves
 *     somebody on a phone with a verdict and nothing to look at.
 *
 * ── Degrade to absent, never to a wrong number ─────────────────────────────
 *
 * `sharp` is banned repo-wide and node has no image decoder, so every pixel
 * measurement is a subprocess that may not exist (`capture/pixels.ts`). With no
 * ImageMagick there is no `score`, no blank check and no measured `changedPct`
 * — the sidecar leaves them ABSENT and the verdict prints `n/a`. In watch mode
 * the diff GATE degrades the other way, to "emit every frame, capped, and SAY
 * that is what happened", because a gate that silently emits nothing is a
 * feature that looks broken.
 *
 * ── Capture never starts a dev server ──────────────────────────────────────
 *
 * Nothing applies itself. A url that does not answer is a refusal in words
 * naming the Build sheet as the way to start one.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BRAND, isCaptureRow } from "@waterplane/shared";
import type { CapturePayload, CaptureRun, CaptureTarget, Intent } from "@waterplane/shared";
import { repoStateDir } from "./branddirs.js";
import { contained } from "./paths.js";
import type { ExecutorResult, IntentManager } from "./intents/manager.js";
import type { CaptureBackend } from "./capture/types.js";
import { BACKENDS, ENABLED, MAX_RUNS, OFF_TEXT, OUT_RING } from "./capture/capturekit.js";
import { cleanTarget, probeCaptureBackends } from "./capture/captureconfig.js";
import { intentToCaptureRun, withLease } from "./capture/capturehelpers.js";
import { runCapturePass } from "./capture/capturepass.js";
import { writeJsonAtomic } from "./jsonstore.js";

// The slices, re-exported so no importer changes (`capture/capture*.ts`).
export { diffRecord, shouldEmit, verdictLine, verificationLevel } from "./capture/captureverdict.js";
export type { EmitInput, VerdictInput, VerificationInput } from "./capture/captureverdict.js";
export { classifyOverlay, cleanTarget, probeCaptureBackends } from "./capture/captureconfig.js";
export type { CleanTargetResult } from "./capture/captureconfig.js";
export { intentToCaptureRun } from "./capture/capturehelpers.js";

export interface CaptureEvents {
  output: (runId: string, chunk: string) => void;
}

export class CaptureManager extends EventEmitter {
  private output = new Map<string, string>();
  private canceled = new Set<string>();
  private live = new Set<string>();

  constructor(private intents: IntentManager) { super(); }

  private configPath(repoDir: string): string { return join(repoStateDir(repoDir), "capture.json"); }

  /** The raw rows as they are on disk, so a refusal can quote the one that is wrong. */
  private readRaw(repoDir: string): unknown[] {
    try {
      const doc = JSON.parse(readFileSync(this.configPath(repoDir), "utf8"));
      const arr = Array.isArray(doc) ? doc : doc?.targets;
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];   // no file / bad json → no targets
    }
  }

  /** A repo's configured capture targets (empty if none/unreadable). */
  list(repoDir: string): CaptureTarget[] {
    const out: CaptureTarget[] = [];
    this.readRaw(repoDir).forEach((v, i) => {
      const c = cleanTarget(v, i);
      if (c.ok) out.push(c.target);
    });
    return out;
  }

  /** Persist a repo's whole target list; returns the cleaned list actually written. */
  save(repoDir: string, targets: CaptureTarget[]): CaptureTarget[] {
    const clean: CaptureTarget[] = [];
    (Array.isArray(targets) ? targets : []).forEach((v, i) => {
      const c = cleanTarget(v, i);
      if (c.ok) clean.push(c.target);
    });
    try {
      const path = this.configPath(repoDir);
      mkdirSync(dirname(path), { recursive: true });
      writeJsonAtomic(path, { version: 1, targets: clean }, { space: 2 });
    } catch { /* best-effort, exactly like builds.ts */ }
    return clean;
  }

  /** This repo's runs, newest first — rendered from the rows that are them. */
  runsFor(repoDir: string): CaptureRun[] {
    return this.intents.list()
      .filter((i) => isCaptureRow(i) && i.cwd === repoDir)
      .slice(0, MAX_RUNS)
      .map(intentToCaptureRun);
  }

  getOutput(runId: string): string { return this.output.get(runId) ?? ""; }

  /**
   * Resolve one target and its working dir, or answer the sentence saying why
   * not. Shared by `run()` (so a refusal reaches the phone while there is still
   * a socket to tell) and `execute()` (so a config edited in between is caught
   * rather than run from a stale snapshot).
   */
  private resolveTarget(repoDir: string, targetId: string): { target: CaptureTarget; cwd: string } | { error: string } {
    const raw = this.readRaw(repoDir);
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i] as Record<string, any> | null;
      if (!row || typeof row !== "object" || row.id !== targetId) continue;
      const c = cleanTarget(row, i);
      if (!c.ok) return { error: c.reason };
      const root = resolve(repoDir);
      let cwd = root;
      if (c.target.dir) {
        const full = contained(root, c.target.dir);
        if (full === null) return { error: `"${c.target.dir}" is outside this repo.` };
        if (!existsSync(full)) return { error: `working dir "${c.target.dir}" does not exist in this repo.` };
        cwd = full;
      }
      return { target: c.target, cwd };
    }
    return { error: `there is no capture target "${targetId}" in ${basename(dirname(this.configPath(repoDir)))}/capture.json any more.` };
  }

  /**
   * Run one configured target now.
   *
   * Everything knowable synchronously is refused synchronously — unknown
   * target, unknown backend (naming the known ids), a working dir outside the
   * repo, a half-configured target — because a refusal minutes later inside an
   * executor reaches a phone that has moved on.
   */
  run(repoDir: string, targetId: string, watch?: boolean): CaptureRun | { error: string } {
    if (!ENABLED) return { error: OFF_TEXT };
    const r = this.resolveTarget(repoDir, targetId);
    if ("error" in r) return { error: r.error };
    const bad = BACKENDS[r.target.backend].validate(r.target);
    if (bad) return { error: bad };

    const runId = "cr_" + randomUUID().slice(0, 8);
    const payload = {
      kind: "capture" as const,
      targetId: r.target.id,
      name: r.target.name,
      backend: r.target.backend,
      watch: watch === true ? true : undefined,
    } satisfies CapturePayload;
    const posted = this.intents.post({
      id: runId,
      cwd: repoDir,
      payload,
      target: { kind: "shell" },
      trigger: { kind: "now" },
      title: r.target.name,
    });
    if (!posted.ok || !posted.intent) return { error: posted.reason || "could not be written down" };
    return intentToCaptureRun(posted.intent);
  }

  /**
   * Call a run off — null when it was called off, and otherwise the SENTENCE
   * saying why it could not be.
   *
   * `this.live` only knows about runs THIS process is executing right now, and
   * it used to be the whole answer: anything else got `false`, which the route
   * worded as "that capture has already finished". That is untrue of a row that
   * has been posted and is still waiting its turn — a cancel for it was
   * silently dropped and the run then went ahead. So a run that is not live is
   * handed to the intent store, which is where a not-yet-started row lives and
   * which can genuinely settle it `canceled`.
   *
   * A live run is flagged rather than killed: the loop checks between frames,
   * so a watch run stops at a frame boundary rather than mid-write.
   */
  cancel(runId: string): string | null {
    if (this.live.has(runId)) {
      this.canceled.add(runId);
      return null;
    }
    const row = this.intents.get(runId);
    if (!row) return "there is no capture run by that id any more.";
    if (row.state === "done" || row.state === "failed") return "that capture has already finished.";
    if (row.state === "canceled") return "that capture was already called off.";
    if (this.intents.cancel(runId, "capture called off from the phone")) return null;
    // `starting`/`running` but not in `live`: the executor belongs to a process
    // that is gone (a restart mid-run). Nothing here can reach it.
    return "that capture is already under way and cannot be called off from here.";
  }

  /** The executor. Resolves when the frames are written and the sidecar is on disk. */
  async execute(i: Intent): Promise<ExecutorResult> {
    const p = i.payload.kind === "capture" ? i.payload : null;
    if (!p) return { ok: false, detail: "that row is not a capture" };
    if (!ENABLED) return { ok: false, detail: OFF_TEXT };

    const runId = i.id;
    this.output.set(runId, "");
    this.canceled.delete(runId);
    this.live.add(runId);
    const log = (line: string) => {
      const chunk = `${line}\r\n`;
      this.append(runId, chunk);
      this.emit("output", runId, chunk);
    };

    try {
      const r = this.resolveTarget(i.cwd, p.targetId);
      if ("error" in r) { log(`[capture] ${r.error}`); return { ok: false, detail: r.error }; }
      const backend = BACKENDS[r.target.backend];
      const bad = backend.validate(r.target);
      if (bad) { log(`[capture] ${bad}`); return { ok: false, detail: bad }; }
      // Through the CACHE, not `backend.probe()` directly: a cold ciqkit probe
      // shells out to python, and asking it again per run — moments after the
      // sheet that started the run already asked — pays for the same answer
      // twice. `probeCaptureBackends` is the one place the 30 s TTL lives.
      const avail = (await probeCaptureBackends(r.cwd)).find((b) => b.id === r.target.backend);
      if (!avail || !avail.available) {
        const why = avail?.reason ?? `the ${r.target.backend} backend is not available here.`;
        log(`[capture] ${why}`);
        return { ok: false, detail: why };
      }

      let tmpDir: string;
      try { tmpDir = mkdtempSync(join(tmpdir(), `${BRAND.slug}-capture-${runId}-`)); }
      catch (e) { return { ok: false, detail: `no scratch dir for the frames: ${String((e as Error)?.message ?? e)}` }; }

      try {
        return await withLease(backend.leaseKey(r.target), () =>
          this.capture(i, r.target, backend, r.cwd, tmpDir, !!p.watch, log));
      } finally {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    } catch (e) {
      const why = String((e as Error)?.message ?? e);
      log(`[capture] ${why}`);
      return { ok: false, detail: why };
    } finally {
      this.live.delete(runId);
      this.canceled.delete(runId);
    }
  }

  /** verify → settle → diff → emit, once per pass — `capture/capturepass.ts`. */
  private capture(
    i: Intent,
    target: CaptureTarget,
    backend: CaptureBackend,
    cwd: string,
    tmpDir: string,
    watch: boolean,
    log: (l: string) => void,
  ): Promise<ExecutorResult> {
    return runCapturePass(this.canceled, i, target, backend, cwd, tmpDir, watch, log);
  }

  private append(runId: string, chunk: string): void {
    const cur = (this.output.get(runId) ?? "") + chunk;
    this.output.set(runId, cur.length > OUT_RING ? cur.slice(-OUT_RING) : cur);
  }
}
