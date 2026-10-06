/**
 * The `garmin` backend — ciqkit, shelled out, and never anything else.
 *
 * ciqkit owns the Connect IQ simulator: it builds the project, pushes the
 * `.prg`, verifies the app actually LOADED (Connect IQ shows a blue loading
 * triangle that passes every cheap "is it blank / did it change" check, which
 * is why a naive screenshot of that simulator is usually a picture of the
 * loader), and OCRs the frame against the anchors. All of that is behind one
 * command. This file runs that command and reads its JSON.
 *
 * ── Never import it, never vendor it ───────────────────────────────────────
 *
 * It is a Python package with its own broker, its own lease and its own
 * lifecycle. Copying any of that here would give the machine two things that
 * each believe they own the simulator.
 *
 * ── And therefore: this backend takes NO lease ─────────────────────────────
 *
 * `leaseKey()` returns null. ciqkit's broker IS the lease — it queues jobs and
 * runs them one at a time. Holding a second, waterplane-side lease around a command
 * that is already waiting on ciqkit's queue would deadlock the two against each
 * other the moment anything else on the machine submitted a ciqkit job.
 *
 * ── Exit 3 is a downgrade, not a failure ───────────────────────────────────
 *
 * `ciqkit sim shot` exits 0 when it captured (anchor found, or OCR simply not
 * installed), 1 when the job failed, and 3 when it captured a frame and OCR
 * said the anchor text was NOT on it. Exit 3 still WROTE A PNG — a picture of
 * the wrong screen is the most useful thing you can be handed when you asked
 * for a screen and got a different one. So it records the missing anchors,
 * downgrades the verification level, and keeps the file. Treating it as a hard
 * failure would delete the evidence.
 *
 * Exit 0 with `anchor: null` means OCR is not installed, so no oracle reading
 * happened at all — `oracle()` returns null and the level caps at `stable`.
 * That is a different fact from "the anchor was checked and found".
 *
 * ── And exit 1 is two different things ─────────────────────────────────────
 *
 * A job that failed, and a WAIT that gave up on a job which is still running.
 * ciqkit exits 1 for both and separates them in its JSON (`error: "wait
 * timeout"`). The second is not a failure of anything the user did — the
 * simulator work carries on and writes its PNG later — so it gets its own
 * sentence, and `--max` keeps ciqkit's wait inside our own kill so the two
 * cannot race.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CaptureBackendInfo, CaptureTarget } from "@waterplane/shared";
import type {
  CaptureBackend, CaptureCtx, CapturePass, CaptureSession, FrameResult, OracleReading,
} from "./types.js";
import { env } from "../env.js";
import { envName } from "@waterplane/shared";

const CIQKIT = env("CIQKIT_BIN") || "ciqkit";
/** A cold push costs one simulator restart — measured at ~87 s in ciqkit's own
 *  notes — so this is generous on purpose. */
const SHOT_MS = 8 * 60_000;
/**
 * How long ciqkit itself is told to wait, in seconds — deliberately INSIDE
 * `SHOT_MS`.
 *
 * `ciqkit sim shot` defaults to a 360 s wait and then exits 1 with
 * `error: "wait timeout"` — which is not a failure: the broker's job keeps
 * running and still writes its PNG (`docs/sim.md`). Our own 8-minute SIGKILL
 * was outside that, so on a busy queue ciqkit gave up first and we reported
 * "the job failed" about a job that was about to succeed. Handing ciqkit
 * `--max` (its client-side wait, not the job's deadline) aligns the two and
 * leaves our kill as the backstop it was meant to be.
 */
const SHOT_WAIT_S = Math.round(SHOT_MS / 1000) - 30;
const SCORE_MS = 60_000;

interface Ran { code: number | null; out: string; err: string }

function run(bin: string, args: string[], timeoutMs: number, cwd?: string): Promise<Ran | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Ran | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      p.stdout.on("data", (d) => { out += d.toString(); });
      p.stderr.on("data", (d) => { err += d.toString(); });
      const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } finish(null); }, timeoutMs);
      p.on("error", () => { clearTimeout(timer); finish(null); });
      p.on("exit", (code) => { clearTimeout(timer); finish({ code, out, err }); });
    } catch {
      finish(null);
    }
  });
}

/** The SHOT chunk's own result out of ciqkit's job JSON. */
function shotResult(stdout: string): { path?: string; anchor?: boolean | null } | null {
  let doc: any;
  try { doc = JSON.parse(stdout); } catch { return null; }
  const steps = doc?.job?.results;
  if (!Array.isArray(steps)) return null;
  for (const s of steps) {
    if (s?.kind !== "shot") continue;
    const r = s.result ?? {};
    return { path: typeof r.path === "string" ? r.path : undefined, anchor: r.anchor ?? null };
  }
  return null;
}

/**
 * The job JSON of a wait that gave up rather than a job that failed.
 *
 * `ciqkit sim shot` exits 1 for both, so the exit code alone cannot tell them
 * apart — the JSON on stdout can (`{"ok": false, "error": "wait timeout", "job":
 * {...}}`, and ciqkit's own stderr note says the job keeps running). Null when
 * this was a real failure.
 */
function waitTimeout(stdout: string): { jobId?: string; state?: string } | null {
  let doc: any;
  try { doc = JSON.parse(stdout); } catch { return null; }
  if (doc?.error !== "wait timeout") return null;
  const job = doc?.job ?? {};
  return {
    jobId: typeof job.id === "string" ? job.id : undefined,
    state: typeof job.state === "string" ? job.state : undefined,
  };
}

/**
 * `ciqkit shot-score <png> --json` → the 0-100 for one file, or null.
 *
 * A PATH, which `shot-score` takes as either a file or a directory — so this
 * can be asked about the one frame that was kept, after the settle loop, rather
 * than about a directory mid-run. It is a python process with numpy behind it;
 * `CaptureSession.score()` is why it is now paid for once per run instead of
 * once per discarded sample.
 */
async function scoreOf(file: string): Promise<number | null> {
  const r = await run(CIQKIT, ["shot-score", file, "--json"], SCORE_MS);
  if (!r || r.code === null) return null;
  let rows: any;
  try { rows = JSON.parse(r.out); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const hit = rows.find((x) => typeof x?.path === "string" && (x.path === file || String(x.path).endsWith(`/${file.split("/").pop()}`)))
    ?? (rows.length === 1 ? rows[0] : null);
  const n = Number(hit?.score);
  return Number.isFinite(n) ? n : null;
}

class GarminSession implements CaptureSession {
  private shot = 0;
  /** The last frame's anchor verdict, straight from ciqkit's OCR.
   *  `null` = OCR did not run, which is NOT "the anchor was missing". */
  private lastAnchor: boolean | null = null;

  constructor(private t: CaptureTarget, private ctx: CaptureCtx) {}

  async frame(absPath: string): Promise<FrameResult> {
    const screen = this.t.screen!;
    // A fresh out-dir per frame: ciqkit names its output after the screen, so
    // two samples into one directory would overwrite each other and the settle
    // check would compare a file with itself.
    const outDir = join(this.ctx.tmpDir, `ciq-${++this.shot}`);
    mkdirSync(outDir, { recursive: true });

    const args = ["sim", "shot", screen, "--project", this.ctx.cwd, "--out-dir", outDir,
      "--max", String(SHOT_WAIT_S)];
    // `--force` on the FIRST frame of the run ONLY.
    //
    // It defeats ciqkit's warm shortcut — the broker skips the re-push when the
    // same project is already loaded, "which is what makes a repeat capture
    // take 5 s instead of 80" (`docs/sim.md`). Frame 1 must force it, because
    // the reason somebody is capturing is usually that they just rebuilt and
    // the output path is unchanged, so the warm path would re-shoot the
    // PREVIOUS build's screen. Frames 2+ are the settle loop asking the SAME
    // build whether the screen has stopped moving; nothing rebuilds between
    // them, and forcing there costs ~80 s a sample to re-push what is already
    // up — which is the entire point of a settle loop, spent.
    if (this.shot === 1) args.push("--force");
    if (this.t.device) args.push("--device", this.t.device);
    for (const a of this.ctx.anchors) args.push("--anchor", a);

    const r = await run(CIQKIT, args, SHOT_MS, this.ctx.cwd);
    if (!r) throw new Error(`\`${CIQKIT} sim shot\` did not finish — set ${envName("CIQKIT_BIN")} if ciqkit is somewhere unusual.`);
    if (r.code === 1 || r.code === null) {
      // A wait that timed out is NOT a job that failed: the simulator work
      // carries on and writes its PNG afterwards — into a scratch dir this run
      // is about to delete, which is why the only useful thing to say is what
      // really happened and what to do next. Calling that "the job failed"
      // sends somebody looking for a bug in a build that was fine.
      const wt = r.code === 1 ? waitTimeout(r.out) : null;
      if (wt) {
        throw new Error(
          `ciqkit is still working on "${screen}" — the wait ran out after ${SHOT_WAIT_S}s with the job `
          + `${wt.state ?? "queued"}${wt.jobId ? ` (${wt.jobId})` : ""}. The job did NOT fail and will still finish; `
          + "check the queue with `ciqkit sim status` and run this target again when it is clear.",
        );
      }
      throw new Error(`ciqkit could not capture "${screen}": ${(r.err || r.out).trim().slice(0, 400) || "the job failed"}`);
    }

    const res = shotResult(r.out);
    const produced = res?.path && existsSync(res.path)
      ? res.path
      : join(outDir, `${screen}.png`);
    if (!existsSync(produced)) throw new Error(`ciqkit reported success but wrote no PNG for "${screen}".`);

    // Exit 3 = captured, and OCR contradicted the anchor. Keep the frame.
    this.lastAnchor = r.code === 3 ? false : (res?.anchor ?? null);
    if (r.code === 3) ctx3(this.ctx, screen);

    // No score here. It used to be taken before the move, on the theory that
    // `shot-score` only accepts a DIRECTORY and the rename would empty this
    // one — it accepts a FILE too, so `score()` below asks about the frame that
    // was actually kept, once, instead of starting python per sample.
    try { renameSync(produced, absPath); } catch { copyFileSync(produced, absPath); }
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { path: absPath };
  }

  /** The kept frame's 0-100, asked once per run. Null ⇒ no scorer here, which
   *  stays ABSENT in the sidecar rather than becoming a zero. */
  async score(absPath: string): Promise<number | null> {
    return scoreOf(absPath);
  }

  async oracle(): Promise<OracleReading | null> {
    // No anchors asked for, or OCR never ran ⇒ nobody was asked.
    if (!this.ctx.anchors.length || this.lastAnchor === null) return null;
    return this.lastAnchor
      ? { found: this.ctx.anchors.slice(), missing: [] }
      : { found: [], missing: this.ctx.anchors.slice() };
  }

  async end(): Promise<void> { /* the broker owns the simulator, not us */ }
}

function ctx3(ctx: CaptureCtx, screen: string): void {
  ctx.log(`[capture] ciqkit captured "${screen}" but its OCR did not find the anchor text — frame kept, level downgraded.`);
}

export const garminBackend: CaptureBackend = {
  id: "garmin",

  async probe(): Promise<CaptureBackendInfo> {
    const r = await run(CIQKIT, ["sim", "--help"], 30_000);
    if (!r) {
      return {
        id: "garmin",
        available: false,
        reason: `garmin capture needs ciqkit on PATH (or ${envName("CIQKIT_BIN")} pointing at it) — \`${CIQKIT}\` did not run.`,
      };
    }
    if (r.code !== 0) {
      const said = (r.err || r.out).trim().split("\n").slice(0, 3).join(" ").slice(0, 300);
      return { id: "garmin", available: false, reason: said || `\`${CIQKIT} sim\` exited ${r.code}.` };
    }
    return { id: "garmin", available: true, reason: "ciqkit is here" };
  },

  /** NO lease. ciqkit's broker is the lease — see the header. */
  leaseKey(): string | null { return null; },

  validate(t: CaptureTarget): string | null {
    if (!t.screen || !t.screen.trim()) {
      return "this garmin target has no `screen` yet — it is the name `ciqkit sim shot` captures.";
    }
    return null;
  },

  passes(): CapturePass[] { return [{ label: "device" }]; },

  async open(t: CaptureTarget, ctx: CaptureCtx): Promise<CaptureSession> {
    ctx.log(`[capture] ciqkit sim shot ${t.screen}${t.device ? ` --device ${t.device}` : ""}`);
    return new GarminSession(t, ctx);
  },
};
