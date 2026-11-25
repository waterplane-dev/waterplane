/**
 * One still of the whole main display through `wp-desktop serve` (helper/PROTOCOL.md): a JPEG config
 * at the native size, the first frame, then EOF. The helper has no one-shot capture command, and
 * adding one is a rebuild, which drops the grants this exists to use. What the core's screenshot
 * asks (`api.screenCapture`) when `screencapture` under node is refused.
 *
 * Never builds: a stale or missing helper has no grant to use, and a screenshot tap must not be
 * what makes macOS forget one.
 */
import { spawn } from "node:child_process";
import type { PluginScreenStill } from "@waterplane/shared";
import type { HelperBin } from "./helperbin.mjs";
import { jsonRecord, KIND_JPEG, KIND_JSON, RecordReader } from "./records.mjs";

/** Near-lossless: text stays sharp, a 4K screen is a few MB. */
const STILL_QUALITY = 95;
const STILL_TIMEOUT_MS = 8000;
const KILL_MS = 1000;

export const STILL_NOT_BUILT = "The live desktop's helper (wp-desktop) could take it, but it is not built and current: open the live desktop once, then try again.";

export interface StillDeps {
  bin: HelperBin;
  /** Extra argv after `serve` (synthetic mode). */
  args: string[];
  timeoutMs?: number;
}

export async function takeStill(d: StillDeps): Promise<PluginScreenStill> {
  const st = await d.bin.check();
  if (st.kind !== "current" && st.kind !== "prebuilt") return { note: STILL_NOT_BUILT };
  return new Promise((resolve) => {
    const child = spawn(st.path, ["serve", ...d.args], { stdio: ["pipe", "pipe", "ignore"] });
    const reader = new RecordReader();
    let done = false;
    const finish = (r: PluginScreenStill): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end(); // EOF is the helper's clean exit
      const kill = setTimeout(() => child.kill("SIGKILL"), KILL_MS);
      kill.unref();
      child.once("exit", () => clearTimeout(kill));
      resolve(r);
    };
    const timer = setTimeout(() => finish({ note: "The desktop helper (wp-desktop) sent no picture in time." }), d.timeoutMs ?? STILL_TIMEOUT_MS);
    child.stdin.on("error", () => { /* EPIPE: the exit handler says what happened */ });
    child.on("error", (err) => finish({ note: `The desktop helper (wp-desktop) could not be started: ${err.message}.` }));
    child.on("exit", (code, signal) => finish({ note: `The desktop helper (wp-desktop) ended without a picture (${signal ?? `exit ${code}`}).` }));
    child.stdout.on("data", (b: Buffer) => {
      if (done) return;
      for (const r of reader.push(b)) {
        if (r.kind === KIND_JPEG) { finish({ jpeg: Buffer.from(r.payload) }); return; }
        const j = r.kind === KIND_JSON ? jsonRecord(r.payload) : null;
        if (j?.t === "status" && j.state === "error") {
          finish({ note: typeof j.reason === "string" && j.reason ? j.reason : "The desktop helper (wp-desktop) could not capture the screen." });
          return;
        }
      }
      if (reader.broken) finish({ note: `The desktop helper (wp-desktop) sent ${reader.broken}.` });
    });
    child.stdin.write(JSON.stringify({ t: "config", codec: "jpeg", source: { kind: "display" }, maxWidth: 0, fps: 5, jpegQuality: STILL_QUALITY, cursor: false }) + "\n");
  });
}
