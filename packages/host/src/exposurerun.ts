/**
 * **Re-check the exposure watch from the phone** (`POST /api/repos/:id/exposure/run`): run the
 * model-free collector for THIS worktree's target once, so the findings the Repo readings sheet
 * draws (`exposure.ts`, off `<state dir>/exposure/<name>.jsonl`) are as of now, not as of the last
 * daily run. Not a paid call: the collector reads registries, GitHub and the stores, never a model.
 *
 *  - **Which target**: `exposureTargetOf` (`exposurewatch.ts`, realpath match). Not listed ⇒ a
 *    sentence, nothing run.
 *  - **Which runner**: `WATERPLANE_EXPOSURE_RUNNER` (an argv split on whitespace, taken as said),
 *    else this checkout's own `tools/exposure.mjs` three hops up (the rule `repohealth.ts` uses for
 *    its bundled engine), run by this node. Neither ⇒ a sentence blaming the desktop — never a fake
 *    success. No shell; the only thing appended is `--target <name>` (plus the Play-key note).
 *  - **One run per target**: a second tap JOINS the run in flight and gets its answer.
 *  - **Bounded**: killed (its whole process group) past `EXPOSURE_RUN_TIMEOUT_MS`, and only the
 *    tail of its output is kept.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { envName, logTag } from "@waterplane/shared";
import type { ExposureRunResult } from "@waterplane/shared";
import { env } from "./env.js";
import { exposureDir } from "./exposure.js";
import { exposureTargetOf } from "./exposurewatch.js";

export const EXPOSURE_RUN_TIMEOUT_MS = 5 * 60_000;
const TAIL_CHARS = 4096;
const PLAY_KEY_MISSING = "re-check from the phone runs without the Play key; the daily run reads it";
const COLLECTOR = "tools/exposure.mjs";
/** This checkout — `packages/host/{src,dist}` three hops down — whose `tools/` holds the collector. */
export const HOST_CHECKOUT = resolve(import.meta.dirname, "../../..");

/** The argv to run for one target, or why there is none. `root` is the host's own checkout. */
export function exposureRunnerArgv(name: string, play: boolean, knob: string | undefined, root: string, has = existsSync):
  { argv: string[] } | { refused: string } {
  const named = (knob ?? "").trim();
  if (named) return { argv: [...named.split(/\s+/), "--target", name] };
  const tool = resolve(root, COLLECTOR);
  if (!has(tool)) {
    return { refused: `No exposure collector on this desktop: none at ${tool}, and ${envName("EXPOSURE_RUNNER")} is not set. Nothing was run.` };
  }
  return { argv: [process.execPath, tool, "run", "--target", name, ...(play ? ["--play-key-missing", PLAY_KEY_MISSING] : [])] };
}

const lastLine = (s: string): string => {
  const l = s.trim().split("\n").map((x) => x.trim()).filter(Boolean).pop() ?? "";
  return l.length > 300 ? `${l.slice(0, 297)}…` : l;
};

/** The collector's exit, as the one sentence the phone shows. Exit codes: `tools/exposure.mjs`'s header. */
export function exposureRunSentence(exit: number | null, tail: string, opts: { timedOut?: boolean; secs?: number } = {}): string {
  const said = lastLine(tail);
  const took = opts.secs !== undefined ? ` (${opts.secs} s)` : "";
  if (opts.timedOut) return `The watch run was stopped after ${Math.round(EXPOSURE_RUN_TIMEOUT_MS / 60_000)} minutes — the findings shown are from the last run that finished.`;
  switch (exit) {
    case 0: return `Watch ran${took}: nothing new since the last run.`;
    case 10: return `Watch ran${took}: something needs you — the findings below are fresh.`;
    case 2: return `Watch ran${took}, but a source could not be reached, so part of the reading is unknown, not clean${said ? `: ${said}` : "."}`;
    case 64: return `The collector refused to run${said ? `: ${said}` : "."}`;
    case null: return `The collector could not be started${said ? `: ${said}` : "."}`;
    default: return `The collector stopped with exit ${exit}${said ? `: ${said}` : "."}`;
  }
}

const inflight = new Map<string, Promise<ExposureRunResult>>();

function runOnce(argv: string[]): Promise<ExposureRunResult> {
  return new Promise((done) => {
    const started = Date.now();
    let tail = "";
    const keep = (b: Buffer) => { tail = (tail + b.toString("utf8")).slice(-TAIL_CHARS); };
    let timedOut = false;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        detached: true, // its own process group, so a timeout reaches what it started
        stdio: ["ignore", "pipe", "pipe"],
        // The collector writes where the readers read: the state dir this host uses.
        env: { ...process.env, [envName("STATE_DIR")]: dirname(exposureDir()) },
      });
    } catch (e) {
      done({ ok: false, exit: null, sentence: exposureRunSentence(null, String((e as Error).message)) });
      return;
    }
    let stderr = "";
    child.stdout?.on("data", keep);
    child.stderr?.on("data", (b: Buffer) => { keep(b); stderr = (stderr + b.toString("utf8")).slice(-TAIL_CHARS); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    }, EXPOSURE_RUN_TIMEOUT_MS);
    let settled = false;
    const finish = (exit: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const secs = Math.round((Date.now() - started) / 1000);
      const sentence = exposureRunSentence(timedOut ? null : exit, stderr.trim() ? stderr : tail + extra, { timedOut, secs });
      if (exit !== 0 && exit !== 10) console.warn(`${logTag} exposure run ${argv.slice(-1)[0]} exit ${exit}${timedOut ? " (timed out)" : ""}: ${lastLine(tail + extra)}`);
      done({ ok: !timedOut && (exit === 0 || exit === 10), exit: timedOut ? null : exit, sentence });
    };
    child.on("error", (e) => finish(null, `\n${e.message}`));
    child.on("close", (code) => finish(code));
  });
}

/** Run (or join) the watch for this worktree. Never throws; a refusal is `ok: false` + `refused`. */
export async function runExposureWatch(wt: string, root: string = HOST_CHECKOUT): Promise<ExposureRunResult> {
  const t = exposureTargetOf(wt);
  if (!t.ok) return { ok: false, exit: null, sentence: t.why, refused: true };
  const running = inflight.get(t.name);
  if (running) return { ...(await running), joined: true };
  const r = exposureRunnerArgv(t.name, t.play, env("EXPOSURE_RUNNER"), root);
  if ("refused" in r) return { ok: false, exit: null, sentence: r.refused, refused: true };
  const p = runOnce(r.argv).finally(() => inflight.delete(t.name));
  inflight.set(t.name, p);
  return p;
}
