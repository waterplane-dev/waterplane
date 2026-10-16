/**
 * What a running push has printed so far, read as it streams: the pre-push
 * hook's steps, the e2e runner's count, and the last few lines.
 *
 * A push here is the whole local CI — build, audit, lint, unit, e2e — and the
 * phone showed one line and a clock for all twenty minutes of it, with no way
 * to tell a suite on its 50th script from a hook stuck on its first step.
 *
 * Read off the local-CI hook's own lines (`> step`, `  ok (12s)`, `FAILED:`,
 * `- step skipped (why)`) and run-e2e's (`[run-e2e] 61 script(s)`, one
 * `[run-e2e] <file> passed|FAILED` per script). Any other hook still gets its
 * tail; a format this does not know yields no steps, never made-up ones.
 */
import type { GitPushProgress } from "@waterplane/shared";

/** How many of the latest lines the phone is shown. */
const TAIL = 4;
/** A line past this is cut — one line of minified output must not become the whole payload. */
const LINE_MAX = 200;

export class PushProgress {
  private steps: GitPushProgress["steps"] = [];
  private e2e: { done: number; failed: number; total: number } | null = null;
  private tail: string[] = [];
  /** The unfinished last line of each stream, so a chunk split mid-line is not two lines. */
  private partial = new Map<string, string>();

  /** Feed a chunk of `stream` ("out"/"err" — kept apart so their halves never splice). */
  feed(stream: string, chunk: string): void {
    const text = (this.partial.get(stream) ?? "") + chunk;
    const parts = text.split("\n");
    this.partial.set(stream, parts.pop() ?? "");
    for (const raw of parts) this.line(raw);
  }

  private line(raw: string): void {
    // A `\r` redraw (a progress bar) keeps only what is on screen last.
    const l = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\r").pop()!.trimEnd();
    if (!l.trim()) return;
    if (/^\(node:\d+\) \[MODULE_TYPELESS_PACKAGE_JSON\]|^Reparsing as ES module|^To eliminate this warning|^\(Use `node --trace-warnings/.test(l)) return;
    this.tail.push(l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 1)}…` : l);
    if (this.tail.length > TAIL) this.tail.shift();

    let m: RegExpExecArray | null;
    if ((m = /^> (.+?)(?: \(advisory\))?$/.exec(l))) {
      this.settleRunning("done");
      this.steps.push({ name: m[1], state: "running" });
    } else if ((m = /^\s+ok(?: \((\d+)s\))?$/.exec(l))) {
      const cur = this.running();
      if (cur) { cur.state = "ok"; if (m[1]) cur.secs = Number(m[1]); }
    } else if (/^\s+failed -- advisory/.test(l)) {
      this.settleRunning("failed");
    } else if ((m = /^FAILED: (.+?) \(exit \d+\)$/.exec(l))) {
      this.settleRunning("failed");
    } else if ((m = /^- (.+) skipped \((.*)\)$/.exec(l))) {
      this.settleRunning("done");
      this.steps.push({ name: m[1], state: "skipped", why: m[2] });
    } else if ((m = /^\[run-e2e\] (\d+) script\(s\)/.exec(l))) {
      this.e2e = { done: 0, failed: 0, total: Number(m[1]) };
    } else if (this.e2e && (m = /^\[run-e2e\] \S+ (passed|FAILED)\b/.exec(l))) {
      this.e2e.done++;
      if (m[1] === "FAILED") this.e2e.failed++;
    }
  }

  private running() { return this.steps.findLast((s) => s.state === "running"); }
  private settleRunning(state: "done" | "failed") { const cur = this.running(); if (cur) cur.state = state; }

  snapshot(): GitPushProgress {
    return {
      steps: this.steps.map((s) => ({ ...s })),
      ...(this.e2e ? { e2e: { ...this.e2e } } : {}),
      tail: [...this.tail],
    };
  }
}
