/**
 * The most context each model has ever been seen to hold, on this host.
 *
 * ── Why a measurement, and why it is persisted ──────────────────────────────
 *
 * `shared/ctxwindow.ts` has the argument in full: the CLI's conversation log
 * records the model but not the window, and it records the BASE id even for a
 * 1M conversation (`claude-opus-5` measured at 998,242 tokens here), so the id
 * alone cannot answer "what is 100% on this chart". What can answer it is the
 * conversation itself — a session that held 346k tokens was not in a 200k
 * window — and `ctxlog.ts` already computes exactly that number on every turn.
 *
 * Persisting it is what makes the answer useful rather than merely correct in
 * hindsight. A high-water mark learned from Monday's long session is what tells
 * Tuesday's fresh one, at 40k, that it is 4% full and not 20%. Keyed by model
 * rather than by session for the same reason: it is a fact about the model.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * Shrink. The mark only ever rises, because the evidence only ever accumulates:
 * "no conversation has exceeded 200k lately" is not evidence of a 200k window,
 * and letting a quiet week walk the axis back down would silently rescale every
 * historical graph. It is also never used raw — `windowContaining` snaps it to
 * a real window — so one long conversation cannot make the axis 346k.
 *
 * Small, boring, and best-effort in the same sense as the other stores here: a
 * corrupt file yields an empty map and a failed write is dropped, because an
 * axis label is not worth taking the daemon down for. Writes are DEBOUNCED —
 * the mark is offered on every turn of every session and almost never moves.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isClaudeModel } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** How long a change waits before it reaches disk. */
const FLUSH_MS = 3_000;
/** Models remembered. Far more than anyone runs; the cap exists so a garbled
 *  model field cannot grow the file without bound. */
const MAX_MODELS = 64;

export class ContextWindowStore {
  private path: string;
  private marks = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(root: string) {
    const dir = hostStateDir(root);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "ctxwindow.json");
    try {
      if (existsSync(this.path)) {
        const raw = readJsonGuarded<any>(this.path, null) as Record<string, unknown>;
        for (const [k, v] of Object.entries(raw ?? {})) {
          if (isClaudeModel(k) && typeof v === "number" && Number.isFinite(v) && v > 0) {
            this.marks.set(k.toLowerCase(), Math.round(v));
          }
        }
      }
    } catch { /* corrupt or unreadable → no marks, never throw on boot */ }
  }

  /** The high-water mark for a model, or null when nothing has been seen. */
  get(model: string | null | undefined): number | null {
    if (!model) return null;
    return this.marks.get(model.trim().toLowerCase()) ?? null;
  }

  /**
   * Offer an observation. Returns true when it MOVED the mark, so a caller can
   * treat that as "the axis for this model just changed" — the one moment a
   * chart's scale is allowed to shift under a reader.
   */
  note(model: string | null | undefined, tok: number): boolean {
    if (!isClaudeModel(model) || !Number.isFinite(tok) || tok <= 0) return false;
    const key = model!.trim().toLowerCase();
    if ((this.marks.get(key) ?? 0) >= tok) return false;
    this.marks.set(key, Math.round(tok));
    if (this.marks.size > MAX_MODELS) {
      // Drop the smallest marks: the big ones are the ones that carry a window
      // the id rule would have got wrong, which is the whole point of the file.
      const keep = [...this.marks.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_MODELS);
      this.marks = new Map(keep);
    }
    this.schedule();
    return true;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS);
    this.timer.unref?.();
  }

  /** Write now. Called on the debounce and on SIGTERM, beside the other flushes. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      writeJsonAtomic(this.path, Object.fromEntries(this.marks), { space: 2 });
    } catch { /* an axis label is not worth taking the daemon down for */ }
  }
}
