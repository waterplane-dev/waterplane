/**
 * The `android` backend — a frame off a real, attached device.
 *
 * `adb exec-out screencap -p` and not `adb shell screencap -p`: the shell path
 * runs the PNG through a pty, which on most devices rewrites every `\n` as
 * `\r\n` and hands back a file no decoder will open. `exec-out` is the same
 * command with the terminal taken out of the way.
 *
 * The oracle is `uiautomator dump`, which is the ONLY way to ask an Android
 * screen what text is on it without OCR. It returns the accessibility tree as
 * XML; the anchors are matched against the `text=` attributes, so an anchor
 * confirms a real labelled view rather than a pixel pattern that looks like
 * one. A device that cannot produce a dump (a secure surface, a screen with no
 * window in focus) makes the oracle absent — which caps the run at `stable`
 * and says so, rather than pretending the anchor was checked.
 *
 * More than one device connected and no `serial` on the target is a REFUSAL in
 * words, never a guess: picking "the first one" would silently screenshot the
 * emulator when the phone in your hand was the point.
 */
import { writeFileSync } from "node:fs";
import type { CaptureBackendInfo, CaptureTarget } from "@waterplane/shared";
import type {
  CaptureBackend, CaptureCtx, CapturePass, CaptureSession, FrameResult, OracleReading,
} from "./types.js";
import { env } from "../env.js";
import { envName } from "@waterplane/shared";
import { execFileP as pexec } from "../proc.js";

const ADB = env("ADB_BIN") || "adb";
/** A 1440x3120 PNG is ~4 MB; retina tablets and a slow dump want headroom. */
const MAX_BUFFER = 64 * 1024 * 1024;
const CMD_MS = 30_000;

interface Devices { ready: string[]; other: string[] }

/** `adb devices` → the serials that are actually usable. */
async function listDevices(): Promise<Devices | null> {
  try {
    const { stdout } = await pexec(ADB, ["devices"], { timeout: CMD_MS });
    const ready: string[] = [], other: string[] = [];
    for (const line of stdout.split("\n").slice(1)) {
      const m = /^(\S+)\s+(\S+)/.exec(line.trim());
      if (!m) continue;
      (m[2] === "device" ? ready : other).push(m[1]);
    }
    return { ready, other };
  } catch {
    return null;
  }
}

/** Which device this target means, or the sentence saying why we cannot tell. */
async function resolveSerial(t: CaptureTarget): Promise<{ serial?: string } | { error: string }> {
  const d = await listDevices();
  if (!d) return { error: `could not run \`${ADB} devices\` — set ${envName("ADB_BIN")} if adb is somewhere unusual.` };
  if (t.serial) {
    if (d.ready.includes(t.serial)) return { serial: t.serial };
    return {
      error: `device ${t.serial} is not attached (adb sees ${d.ready.length ? d.ready.join(", ") : "nothing"}).`,
    };
  }
  if (d.ready.length === 1) return { serial: d.ready[0] };
  if (d.ready.length === 0) {
    const why = d.other.length ? ` (${d.other.join(", ")} are attached but not ready — unlock and allow USB debugging)` : "";
    return { error: `no Android device is attached${why}.` };
  }
  return {
    error: `${d.ready.length} devices are attached (${d.ready.join(", ")}) — give this target a \`serial\` `
      + "so it captures the one you meant.",
  };
}

class AndroidSession implements CaptureSession {
  constructor(private serial: string | undefined, private anchors: string[]) {}

  private args(rest: string[]): string[] {
    return this.serial ? ["-s", this.serial, ...rest] : rest;
  }

  async frame(absPath: string): Promise<FrameResult> {
    const { stdout } = await pexec(ADB, this.args(["exec-out", "screencap", "-p"]), {
      encoding: "buffer", maxBuffer: MAX_BUFFER, timeout: CMD_MS,
    });
    const buf = stdout as unknown as Buffer;
    if (!buf?.length) throw new Error("adb returned an empty frame — is the screen on?");
    writeFileSync(absPath, buf);
    return { path: absPath };
  }

  async oracle(): Promise<OracleReading | null> {
    if (!this.anchors.length) return null;
    let xml = "";
    try {
      // `/dev/tty` makes uiautomator print the tree instead of writing a file
      // we would then have to pull and delete.
      const { stdout } = await pexec(ADB, this.args(["exec-out", "uiautomator", "dump", "/dev/tty"]), {
        maxBuffer: MAX_BUFFER, timeout: CMD_MS,
      });
      xml = String(stdout);
    } catch {
      return null;   // no dump ⇒ nobody was asked ⇒ capped at `stable`
    }
    if (!/<node/.test(xml)) return null;
    const text = [...xml.matchAll(/text="([^"]*)"/g)].map((m) => m[1]).filter(Boolean).join("\n");
    return { text };
  }

  async end(): Promise<void> { /* nothing is held open */ }
}

export const androidBackend: CaptureBackend = {
  id: "android",

  async probe(): Promise<CaptureBackendInfo> {
    const d = await listDevices();
    if (!d) {
      return {
        id: "android",
        available: false,
        reason: `android capture needs \`adb\` on PATH (or ${envName("ADB_BIN")} pointing at it) — \`${ADB}\` did not run.`,
      };
    }
    if (!d.ready.length) {
      return {
        id: "android",
        available: false,
        reason: d.other.length
          ? `adb is here but ${d.other.join(", ")} is not ready — unlock the device and allow USB debugging.`
          : "adb is here, but no device is attached.",
      };
    }
    return { id: "android", available: true, reason: `adb sees ${d.ready.join(", ")}` };
  },

  leaseKey(t: CaptureTarget): string { return `android:${t.serial || "default"}`; },

  validate(): string | null { return null; },

  passes(): CapturePass[] { return [{ label: "device" }]; },

  async open(t: CaptureTarget, ctx: CaptureCtx): Promise<CaptureSession> {
    const r = await resolveSerial(t);
    if ("error" in r) throw new Error(r.error);
    ctx.log(`[capture] device ${r.serial ?? "(default)"}`);
    return new AndroidSession(r.serial, ctx.anchors);
  },
};
