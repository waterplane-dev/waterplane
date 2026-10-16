/**
 * One open view = one `wp-desktop serve` process (helper/PROTOCOL.md, "serve"). Spawned plainly:
 * the helper disclaims TCC responsibility itself, so macOS judges `wp-desktop`, not node.
 *
 * stdin carries JSON lines (`config`, `bitrate`, `keyframe`, `input`, `stop`); stdout carries
 * length-prefixed records (`records.mts`) that become stream frames and status; stderr is the
 * helper's log, kept as a short tail for the sentence when it dies, and relayed line by line only
 * for `--dry-input` (the e2e reads what input WOULD have posted from the host log).
 *
 * The control gate: an input reaches stdin only while the control setting is on AND the event
 * survives `cleanDesktopInput`. Anything else is dropped, with ONE log line per stream per reason.
 *
 * Closing is `stop`, then EOF on stdin (the helper exits within ms), SIGTERM after 1 s and
 * SIGKILL after 3 s for one that did not. A helper that exits on its own ends the view with a
 * sentence.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { STREAM_PAYLOAD_MAX, type PluginStreamSub } from "@waterplane/shared";
import { cleanDesktopInput, cleanDesktopParams, CONTROL_SETTING_PATH, FRAME_H264, FRAME_JPEG, type DesktopParams } from "../shared/wire.mjs";
import { AutoController } from "./auto.mjs";
import { jsonRecord, KIND_H264, KIND_JPEG, KIND_JSON, RecordReader, type HelperRecord } from "./records.mjs";
import { desktopStatus, statsFps } from "./status.mjs";

export interface SessionDeps {
  bin: string;
  /** Extra argv after `serve` (`--source synthetic --no-capture --dry-input` in synthetic mode). */
  args: string[];
  log(msg: string): void;
  /** The person's control setting, read per event. */
  control(): boolean;
  /** Called once the process is gone, however it went. */
  gone(s: HelperSession): void;
  now?(): number;
  termMs?: number;
  killMs?: number;
  /** How often the Auto controller looks when no ack arrives (a link so jammed nothing lands). */
  tickMs?: number;
  /** Source pixels per CGEvent point for these params (the display's backing scale); null when
   *  unknown, and a scroll is then dropped rather than sized by a guess. */
  scale?(p: DesktopParams): number | null;
}

/**
 * The phone's scroll in the helper's terms. The phone says `dy > 0` = the fingers moved down
 * (natural scrolling: the content follows the fingers) in SOURCE pixels; the helper takes the DOM
 * sign (`dy > 0` scrolls the content down, as `WheelEvent.deltaY`) in points. So: negated, and
 * divided by the backing scale. A delta that rounds to nothing is dropped, and so is one with no
 * known scale (null, or not a positive number): a guessed 1 scrolled twice as far on Retina.
 */
export function helperScroll<E extends { dx: number; dy: number }>(ev: E, scale: number | null): E | null {
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) return null;
  const dx = Math.round(-ev.dx / scale), dy = Math.round(-ev.dy / scale);
  return dx === 0 && dy === 0 ? null : { ...ev, dx: dx || 0, dy: dy || 0 };
}

const STATS_EVERY_MS = 2000;
const STDERR_TAIL = 20;

export class HelperSession {
  readonly sub: PluginStreamSub;
  private p: DesktopParams;
  private child: ChildProcess | null = null;
  private reader = new RecordReader();
  private auto: AutoController | null = null;
  private helperStatus: Record<string, unknown> | null = null;
  private measuredFps: number | null = null;
  private lastStatsStatusAt = 0;
  private statusOwed = false;
  private statusTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private killTimers: NodeJS.Timeout[] = [];
  private skips = 0;
  private lastTickAt = 0;
  private closing = false;
  private spawned = false;
  private exited = false;
  private told = new Set<string>();
  private stderrTail: string[] = [];
  private errBuf = "";
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(sub: PluginStreamSub, params: unknown, private readonly d: SessionDeps) {
    this.sub = sub;
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
    this.p = cleanDesktopParams(params);
    if (this.p.auto) this.auto = new AutoController(this.p.bitrateKbps, this.p.fps, this.now());
  }

  get pid(): number | undefined { return this.child?.pid; }
  get params(): DesktopParams { return this.p; }
  get isClosing(): boolean { return this.closing; }
  /** For the close log line: how long it ran. */
  get ageMs(): number { return this.now() - this.startedAt; }

  /** Spawn the helper and hand it its first `config`. Resolves once the process exists: null, or
   *  the sentence that refuses the open (it could not be started at all). */
  start(): Promise<string | null> {
    const child = spawn(this.d.bin, ["serve", ...this.d.args], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const started = new Promise<string | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (err) => { if (!this.spawned) { this.closing = true; resolve(`The desktop helper could not be started: ${err.message}.`); } });
    });
    child.once("spawn", () => { this.spawned = true; });
    child.stdin.on("error", () => { /* EPIPE: the exit handler says what happened */ });
    child.stdout.on("data", (b: Buffer) => this.onStdout(b));
    child.stderr.on("data", (b: Buffer) => this.onStderr(b));
    child.on("error", (err) => this.onExit(null, null, err));
    child.on("exit", (code, signal) => this.onExit(code, signal, null));
    this.writeConfig();
    this.owe();
    this.tickTimer = setInterval(() => { if (this.now() - this.lastTickAt >= (this.d.tickMs ?? 1000)) this.tick(); }, this.d.tickMs ?? 1000);
    return started;
  }

  setParams(raw: unknown): void {
    if (this.closing) return;
    const next = cleanDesktopParams(raw);
    if (next.auto) {
      if (!this.auto) this.auto = new AutoController(next.bitrateKbps, next.fps, this.now());
      else this.auto.setCaps(next.bitrateKbps, next.fps, this.now(), this.sub.sentBytes);
    } else {
      this.auto = null;
    }
    const region = JSON.stringify([this.p.crop ?? null, this.p.source]) !== JSON.stringify([next.crop ?? null, next.source]);
    this.p = next;
    this.writeConfig();
    // The phone treats the next key after a crop change as the new region: ask for it outright
    // (the helper forgets its old frame on such a config, so this key is of the new region).
    if (region) this.keyframe();
    this.owe();
  }

  keyframe(): void { this.write({ t: "keyframe" }); }

  input(raw: unknown): void {
    if (this.closing) return;
    if (!this.d.control()) { this.once("control-off", `input dropped: control is off for this desktop (${CONTROL_SETTING_PATH})`); return; }
    const clean = cleanDesktopInput(raw);
    if (!clean) { this.once("bad-input", "input dropped: an event that is not a valid desktop input"); return; }
    if (clean.k === "scroll") {
      const scale = this.d.scale?.(this.p) ?? null;
      if (scale === null) { this.once("no-scale", "scroll dropped: the display's backing scale is not known yet (no probe has said it)"); return; }
      const ev = helperScroll(clean, scale);
      if (ev) this.write({ t: "input", ev });
      return;
    }
    this.write({ t: "input", ev: clean });
  }

  /** A `stream.ack` arrived. */
  ack(): void { this.tick(); this.flushStatus(); }

  /** The control setting moved: the view says so at once. */
  controlChanged(): void { this.owe(); }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.clearTimers();
    if (this.exited || !this.child) { this.d.gone(this); return; }
    this.write({ t: "stop" });
    try { this.child.stdin?.end(); } catch { /* already closed */ }
    const child = this.child;
    this.killTimers.push(setTimeout(() => { if (!this.exited) child.kill("SIGTERM"); }, this.d.termMs ?? 1000));
    this.killTimers.push(setTimeout(() => { if (!this.exited) child.kill("SIGKILL"); }, this.d.killMs ?? 3000));
  }

  // ── stdout ───────────────────────────────────────────────────────────────

  private onStdout(b: Buffer): void {
    for (const r of this.reader.push(b)) this.onRecord(r);
    if (this.reader.broken && !this.closing) {
      this.d.log(`helper stdout unreadable (${this.reader.broken}); ending the view`);
      this.sub.end("The desktop helper sent something unreadable, so the view stopped. Open it again to restart it.");
      this.close();
    }
    this.flushStatus();
  }

  private onRecord(r: HelperRecord): void {
    if (this.closing) return;
    if (r.kind === KIND_H264 || r.kind === KIND_JPEG) {
      if (r.payload.byteLength > STREAM_PAYLOAD_MAX) {
        this.skips++;
        this.once("too-big", `a frame of ${r.payload.byteLength} bytes is over the ${STREAM_PAYLOAD_MAX} one frame may carry; skipped (lower the resolution or the JPEG quality)`);
        return;
      }
      const jpeg = r.kind === KIND_JPEG;
      // A JPEG is always a whole picture: key, and droppable (the next still replaces it).
      const res = this.sub.send(r.payload, { kind: jpeg ? FRAME_JPEG : FRAME_H264, key: r.key || jpeg, droppable: !r.key || jpeg });
      if (res === "skipped") this.skips++;
      return;
    }
    if (r.kind !== KIND_JSON) return; // a kind this host does not read (cursor, later): skipped
    const o = jsonRecord(r.payload);
    if (!o) return;
    if (o.t === "status") {
      this.helperStatus = o;
      if (o.state !== "running") this.measuredFps = null;
      this.owe();
    } else if (o.t === "stats") {
      const fps = statsFps(o);
      if (fps !== null) this.measuredFps = fps;
      if (this.now() - this.lastStatsStatusAt >= STATS_EVERY_MS) { this.lastStatsStatusAt = this.now(); this.owe(); }
    }
  }

  // ── status ───────────────────────────────────────────────────────────────

  private owe(): void { this.statusOwed = true; this.flushStatus(); }

  /** Send the owed status. Before `stream.opened` the core refuses it: retried shortly. */
  private flushStatus(): void {
    if (!this.statusOwed || this.closing) return;
    const refusal = this.sub.status(desktopStatus({
      helper: this.helperStatus, measuredFps: this.measuredFps, bitrateKbps: this.auto?.kbps ?? this.p.bitrateKbps, control: this.d.control(),
    }));
    if (refusal === null) { this.statusOwed = false; return; }
    if (/not open yet/.test(refusal) && !this.statusTimer) {
      this.statusTimer = setTimeout(() => { this.statusTimer = null; this.flushStatus(); }, 50);
    } else if (!/not open yet/.test(refusal)) {
      this.statusOwed = false;
    }
  }

  // ── Auto ─────────────────────────────────────────────────────────────────

  private tick(): void {
    this.lastTickAt = this.now();
    if (!this.auto || this.closing) return;
    const ch = this.auto.tick({ sent: this.sub.sentBytes, rx: this.sub.lastAck?.rxBytes ?? null, skips: this.skips, now: this.now() });
    if (!ch) return;
    if (ch.fpsChanged) this.writeConfig();
    else this.write({ t: "bitrate", kbps: ch.kbps });
    this.owe();
  }

  /** The helper's `config`: the cleaned params, with the bitrate and frame rate the host chose. */
  private writeConfig(): void {
    const { auto: _auto, ...rest } = this.p;
    this.write({ t: "config", ...rest, bitrateKbps: this.auto?.kbps ?? this.p.bitrateKbps, fps: this.auto?.fps ?? this.p.fps });
  }

  // ── process ──────────────────────────────────────────────────────────────

  private write(o: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin || this.exited || stdin.destroyed || stdin.writableEnded) return;
    try { stdin.write(JSON.stringify(o) + "\n"); } catch { /* the exit handler speaks */ }
  }

  private onStderr(b: Buffer): void {
    this.errBuf += b.toString("utf8");
    let i: number;
    while ((i = this.errBuf.indexOf("\n")) >= 0) {
      const line = this.errBuf.slice(0, i).trimEnd();
      this.errBuf = this.errBuf.slice(i + 1);
      if (!line) continue;
      this.stderrTail.push(line.slice(0, 300));
      if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
      if (/dry-input: /.test(line)) this.d.log(`id=${this.sub.key} ${line}`);
    }
    if (this.errBuf.length > 8192) this.errBuf = this.errBuf.slice(-8192);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, err: Error | null): void {
    if (this.exited) return;
    this.exited = true;
    this.clearTimers();
    for (const t of this.killTimers) clearTimeout(t);
    if (!this.closing) {
      const why = err
        ? `The desktop helper could not be started: ${err.message}.`
        : `The desktop helper stopped unexpectedly (${signal ? `killed by ${signal}` : `exit code ${code}`}). Open the view again to restart it.`;
      this.d.log(`helper for id=${this.sub.key} ended on its own: ${err ? err.message : signal ?? `exit ${code}`}${this.stderrTail.length ? ` — last: ${this.stderrTail.at(-1)}` : ""}`);
      this.closing = true;
      this.sub.end(why);
    }
    this.d.gone(this);
  }

  private clearTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.tickTimer = null;
    this.statusTimer = null;
  }

  private once(key: string, line: string): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.d.log(`id=${this.sub.key} ${line}`);
  }
}
