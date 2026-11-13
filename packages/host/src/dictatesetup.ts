/**
 * Set local dictation up on a person's tap: whisper.cpp through brew (macOS),
 * and one ggml model downloaded from upstream, verified by a pinned sha256.
 *
 * Nothing applies itself: only `startDictateSetup` (a POST) begins work, a
 * failure is a sentence and is never retried, and the weights are fetched from
 * the upstream host on request — never bundled or redistributed.
 *
 * ONE job at a time. The disk check runs before any byte is fetched: a low disk
 * on this desktop ends Tailscale, so the model never takes the last 2 GB.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, rename, rm, statfs } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Writable } from "node:stream";
import { dirname, join } from "node:path";
import {
  DICTATE_DISK_MARGIN_BYTES, DICTATE_MODELS, dictateModelById, dictateModelUrl,
  envName, type DictateModel, type DictateModelChoice, type DictateStatus, type DictateSetupState, type DictateSetupStep,
} from "@waterplane/shared";
import { binary, dictateStatusLive, modelDir, modelPath, onPath, resetEngineCache, resolveBin, whisperInstallHint } from "./dictate.js";
import { env } from "./env.js";

const BREW_TIMEOUT_MS = 15 * 60_000;
const IDLE_MS = 60_000;
const DEADLINE_MS = 60 * 60_000;

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

/** A step that failed, carrying the sentence the person will read. */
export class SetupFailure extends Error {
  constructor(readonly step: DictateSetupStep, message: string) { super(message); }
}

/** The brew binary: on PATH, else the two places Homebrew installs it (a
 *  launchd service's PATH usually lacks them). */
export function findBrew(): string | null {
  if (process.platform !== "darwin") return null;
  // resolveBin falls back to Homebrew's two bin dirs, so a launchd PATH without them still finds it;
  // the resolved path, never the bare name, because execFile would look the bare name up on that PATH.
  return resolveBin("brew");
}

/** Why a tap on "set up" could not help here, as a sentence naming the setting; null when it can. */
export function setupRefusal(): string | null {
  if (env("DICTATE") === "0") return `Dictation is switched off on this host (${envName("DICTATE")}=0), so setting it up would change nothing. Remove that setting first.`;
  const named = (env("WHISPER_MODEL") || "").trim();
  if (named && !modelPath()) return `${envName("WHISPER_MODEL")} points at ${named}, which does not exist, so a downloaded model would not be used. Fix or remove that setting first.`;
  const bin = binary();
  if (bin !== "whisper-cli" && !onPath(bin)) return `${envName("WHISPER_BIN")} names ${bin}, which is not installed, and setup only installs whisper-cli. Fix or remove that setting first.`;
  return null;
}

/** Whether a tap on "set up" can work here: nothing in the settings defeats it, and
 *  whisper-cli is already present or brew can install it. Else the install hint, not a button. */
export function canSetupDictation(): boolean {
  return setupRefusal() === null && (onPath(binary()) || findBrew() !== null);
}

export function dictateModelChoices(dir: string = modelDir()): DictateModelChoice[] {
  return DICTATE_MODELS.map((m) => ({
    id: m.id, file: m.file, bytes: m.bytes, note: m.note, recommended: m.recommended,
    installed: hasModelFile(dir, m),
  }));
}

/** The status the phone's GET draws, plus what it needs to offer a setup (so no second call). */
export async function dictateStatusWithSetup(): Promise<DictateStatus> {
  const st = await dictateStatusLive();
  if (!st.available && canSetupDictation()) { st.canSetup = true; st.models = dictateModelChoices(); }
  return st;
}

function hasModelFile(dir: string, m: DictateModel): boolean {
  try { return statSync(join(dir, m.file)).size === m.bytes; } catch { return false; }
}

/** Free bytes on the volume that holds `path` (nearest existing ancestor). */
export async function freeBytes(path: string): Promise<number> {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const s = await statfs(p);
  return Number(s.bavail) * Number(s.bsize);
}

/** Refuse, in a sentence naming both numbers, when the download would eat into the margin. */
export function diskRefusal(free: number, need: number, margin = DICTATE_DISK_MARGIN_BYTES): string | null {
  if (free >= need + margin) return null;
  return `Not enough free disk space: this model needs ${gb(need)} plus ${gb(margin)} kept free, but only ${gb(free)} is free. Free some space and try again.`;
}

export interface DownloadOpts {
  url: string;
  dest: string;
  bytes: number;
  sha256: string;
  onProgress?: (done: number) => void;
  fetchImpl?: typeof fetch;
  /** No bytes for this long ends the job (default 60 s). */
  idleMs?: number;
  /** Overall limit (default 60 min). */
  deadlineMs?: number;
  /** Test seam: the write target for the temp file. */
  createOut?: (path: string) => Writable;
}

/** The temp name this code creates: unique per job, so it never meets install.sh's `<file>.part`. */
export function tempName(dest: string): string {
  return `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
}
const tempPattern = (file: string) => new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.[0-9a-f]+\\.part$`);

/** Remove stale temp files of known model names (only names `tempName` creates). */
export async function sweepStaleParts(dir: string): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  for (const n of names) {
    if (DICTATE_MODELS.some((m) => tempPattern(m.file).test(n))) await rm(join(dir, n), { force: true });
  }
}

const span = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} seconds` : `${Math.round(ms / 60_000)} minutes`;

/**
 * Stream `url` to a unique `.part`, hashing as it goes; rename onto `dest` only when
 * the size and sha256 both match. Any failure (incl. a write error, a stall or the
 * deadline) aborts the request, removes the temp file and throws a `SetupFailure`.
 */
export async function downloadVerified(o: DownloadOpts): Promise<void> {
  const part = tempName(o.dest);
  await mkdir(dirname(o.dest), { recursive: true });
  const f = o.fetchImpl ?? fetch;
  const idleMs = o.idleMs ?? IDLE_MS;
  const deadlineMs = o.deadlineMs ?? DEADLINE_MS;
  const ac = new AbortController();
  let why: string | null = null;
  const abort = (m: string) => { why ??= m; ac.abort(); };
  let idle = setTimeout(() => abort(`stalled: no data for ${span(idleMs)}`), idleMs);
  const deadline = setTimeout(() => abort(`took longer than ${span(deadlineMs)}`), deadlineMs);
  const poke = () => { clearTimeout(idle); idle = setTimeout(() => abort(`stalled: no data for ${span(idleMs)}`), idleMs); };
  const stopTimers = () => { clearTimeout(idle); clearTimeout(deadline); };
  const aborted = new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error(why ?? "aborted"))));
  aborted.catch(() => {});
  let out: Writable | null = null;
  let res: Response | null = null;
  const fail = async (step: DictateSetupStep, msg: string): Promise<never> => {
    stopTimers();
    ac.abort();
    void res?.body?.cancel().catch(() => {});
    out?.destroy();
    await rm(part, { force: true });
    throw new SetupFailure(step, msg);
  };
  try { res = await f(o.url, { redirect: "follow", signal: ac.signal }); }
  catch (e) {
    if (why) return fail("download", `The download ${why}. Try again.`);
    return fail("download", `The download could not start (${(e as Error).message}). Check the desktop's internet connection and try again.`);
  }
  if (!res.ok || !res.body) return fail("download", `The model server answered ${res.status}. Try again later.`);
  const hash = createHash("sha256");
  out = o.createOut ? o.createOut(part) : createWriteStream(part);
  const w = out;
  const outErr = new Promise<never>((_, rej) => w.once("error", rej));
  outErr.catch(() => {});
  let done = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: end } = await Promise.race([reader.read(), aborted, outErr]);
      if (end) break;
      poke();
      hash.update(value);
      done += value.length;
      if (done > o.bytes) throw new Error("size");
      if (!w.write(value)) await Promise.race([new Promise<void>((r) => w.once("drain", () => r())), outErr, aborted]);
      o.onProgress?.(done);
    }
    await Promise.race([new Promise<void>((resolve) => w.end(resolve)), outErr, aborted]);
  } catch (e) {
    if ((e as Error).message === "size") return fail("verify", "The downloaded file is larger than expected, so it was thrown away. Try again.");
    if (why) return fail("download", `The download ${why}. Try again.`);
    return fail("download", `The download was interrupted (${(e as Error).message}). Try again.`);
  }
  stopTimers();
  if (done !== o.bytes) return fail("verify", `The downloaded file is ${done} bytes, expected ${o.bytes}, so it was thrown away. Try again.`);
  if (hash.digest("hex") !== o.sha256) return fail("verify", "The downloaded file did not match its published checksum, so it was thrown away. Try again.");
  await rename(part, o.dest);
}

function run(file: string, args: string[], timeout: number): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-6).join("\n");
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, tail });
    });
  });
}

async function ensureEngine(): Promise<void> {
  if (onPath(binary())) return;
  const brew = findBrew();
  if (!brew) throw new SetupFailure("engine", `${binary()} is not on this desktop's PATH${whisperInstallHint()}`);
  const r = await run(brew, ["install", "whisper-cpp"], BREW_TIMEOUT_MS);
  if (r.code !== 0) throw new SetupFailure("engine", `brew install whisper-cpp failed. Run it in a terminal on the desktop to see why. Last output: ${r.tail}`);
  resetEngineCache();
  if (!onPath(binary())) throw new SetupFailure("engine", `brew finished but ${binary()} is still not on this desktop's PATH or in Homebrew's bin${whisperInstallHint()}`);
}

let state: DictateSetupState = { state: "idle" };

export function dictateSetupState(): DictateSetupState { return state; }

/** Begin ONE setup job. Returns a sentence when it refuses to start. */
export function startDictateSetup(modelId: unknown): { ok: true } | { ok: false; error: string } {
  const m = typeof modelId === "string" ? dictateModelById(modelId) : undefined;
  if (!m) return { ok: false, error: `Unknown model. Choose one of: ${DICTATE_MODELS.map((x) => x.id).join(", ")}.` };
  const refusal = setupRefusal();
  if (refusal) return { ok: false, error: refusal };
  if (state.state === "running") return { ok: false, error: "A dictation setup is already running." };
  state = { state: "running", model: m.id, step: "engine", bytesDone: 0, bytesTotal: m.bytes };
  void runSetup(m).then(
    () => { state = { state: "done", model: m.id }; },
    (e) => {
      const step = e instanceof SetupFailure ? e.step : "download";
      state = { state: "failed", model: m.id, step, reason: e instanceof SetupFailure ? e.message : `Setup failed: ${(e as Error).message}` };
    },
  );
  return { ok: true };
}

function setStep(model: DictateModel, step: DictateSetupStep, bytesDone = 0): void {
  state = { state: "running", model: model.id, step, bytesDone, bytesTotal: model.bytes };
}

async function runSetup(m: DictateModel): Promise<void> {
  const dir = modelDir();
  await sweepStaleParts(dir);
  // A model named by WHISPER_MODEL is the one dictation uses (setupRefusal already checked it exists),
  // so only the engine is missing: never download a model modelPath() would ignore.
  const named = (env("WHISPER_MODEL") || "").trim() !== "";
  const haveModel = named || hasModelFile(dir, m); // size matches: the hash of an existing file is not re-checked
  if (!haveModel) {
    // Before brew: the engine install eats disk too, and the margin must survive the model.
    setStep(m, "disk");
    const refusal = diskRefusal(await freeBytes(dir), m.bytes);
    if (refusal) throw new SetupFailure("disk", refusal);
  }
  setStep(m, "engine");
  await ensureEngine();
  if (haveModel) return;
  setStep(m, "download");
  await downloadVerified({
    url: dictateModelUrl(m), dest: join(dir, m.file), bytes: m.bytes, sha256: m.sha256,
    onProgress: (done) => setStep(m, "download", done),
  });
}
