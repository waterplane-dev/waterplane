/**
 * The pluggable seam of the capture loop — everything per-platform lives behind
 * this file, and nothing behind it may leak forward into `capture.ts`.
 *
 * `capture.ts` owns the ONE loop (verify → settle → diff → emit) and every
 * claim the run is allowed to make about the picture. A backend owns exactly
 * four questions:
 *
 *   • can this machine do it at all, and if not, what should the phone SAY
 *     (`probe`, returning a sentence — never a bare boolean);
 *   • what must not run at the same time as it (`leaseKey`);
 *   • is this particular target configured well enough to run (`validate`,
 *     returning the refusal sentence, or null for "go");
 *   • how many frames one run is (`passes` — a web target with two viewports
 *     and `theme: "both"` is four frames; everything else is one).
 *
 * ── Why `open()` and not a bare `frame(target, ctx)` ───────────────────────
 *
 * The settle loop samples the SAME screen several times in a row, and for the
 * web backend that screen is a live browser page with console and network
 * listeners attached to it. Re-launching Chromium per sample would make the
 * stability check measure the launcher rather than the app, and would throw
 * away the console log the sidecar reports. So a backend hands back a
 * `CaptureSession` that stays open for one pass: `frame()` as many times as the
 * loop wants, `oracle()` once at the end, `end()` always.
 *
 * ── Why `oracle()` may return null, and what that costs ────────────────────
 *
 * `null` means "nobody could be asked". `capture/window.ts` returns it always —
 * a screencapture of somebody else's window has nothing to query — and the
 * garmin backend returns it for a run where no OCR backend was installed. In
 * both cases the level is capped at `stable`: the word "verified" is reserved
 * for an oracle reading that actually happened. This is the whole point of the
 * type, and `verificationLevel()` is where it is enforced.
 *
 * ── The Playwright types ───────────────────────────────────────────────────
 *
 * Deliberately hand-written and `any`-shaped. Playwright is not a dependency of
 * this repo and must never become one (it is a browser download); it is
 * resolved at RUNTIME out of the target repo's own `node_modules`, so there is
 * no package for `@types` to come from and a static import would fail `tsc`
 * on every machine that has not installed it. These are the four calls
 * `capture/web.ts` makes, and nothing more.
 */
import type {
  CaptureBackendId,
  CaptureBackendInfo,
  CaptureOverlayKind,
  CaptureTarget,
  CaptureTheme,
  CaptureViewport,
} from "@waterplane/shared";

/**
 * One frame's worth of intent: which geometry, which colour scheme.
 *
 * `label` is what the run's output calls it ("390x844 dark"), and it is empty
 * on a backend that emulates neither — a phone screenshot is whatever the phone
 * is, and inventing a label for it would be inventing a fact.
 */
export interface CapturePass {
  label: string;
  viewport?: CaptureViewport;
  theme?: CaptureTheme;
}

/**
 * What the running thing said when it was asked what is on its screen.
 *
 * Two shapes, because two kinds of oracle exist. A DOM or a uiautomator dump
 * hands back `text` and the core matches the target's anchors against it. OCR
 * behind somebody else's CLI (ciqkit) hands back a verdict instead — it already
 * did the matching — so it fills `found`/`missing` and those WIN. Collapsing
 * the two into one boolean would throw away "two of the three strings were
 * there", which is the reading somebody actually needs.
 */
export interface OracleReading {
  /** Visible text, for the core to match anchors against. */
  text?: string;
  /** Anchors the oracle resolved itself. Present ⇒ used in place of `text`. */
  found?: string[];
  missing?: string[];
  /** The page's markup, for the core's `classifyOverlay()` to read. The overlay
   *  heuristic is a CORE rule, not a backend one — it is a regex over strings
   *  and belongs where it can be pinned with a fixture and no browser. */
  html?: string;
  /** A failure overlay the backend recognised for itself, when it has a better
   *  way than the markup. Wins over `html`. */
  overlay?: { kind: CaptureOverlayKind; text?: string };
  /**
   * Web only, capped. ABSENT on every other backend — which is a DIFFERENT
   * statement from `{errors: 0}`: one says "we looked and it was clean", the
   * other says "there was nobody to ask", and the verdict prints `console: n/a`
   * for the second.
   */
  console?: { errors: number; warnings: number; lines: string[] };
  /** Web only; ABSENT elsewhere, same distinction. */
  network?: { failed: number; lines: string[] };
}

/** What one `frame()` produced. Everything optional is "not measured". */
export interface FrameResult {
  /** Absolute path of the PNG that was written. */
  path: string;
  /** Geometry, when the backend knows it first-hand. The core falls back to
   *  reading the PNG's own header, and to ABSENT when that will not parse. */
  viewport?: CaptureViewport;
  /** 0–100 advisory, when a scorer ran. ABSENT — never 0 — when none exists. */
  score?: number;
  /** One line for the run's output; the backend's chance to say what it did
   *  ("window not found — captured the whole desktop"). */
  note?: string;
}

/** What a backend is handed for one pass. */
export interface CaptureCtx {
  /** Absolute working dir, already traversal-guarded to the worktree. */
  cwd: string;
  /** A scratch dir for this run's frames. Emptied by the core afterwards. */
  tmpDir: string;
  pass: CapturePass;
  /** The target's anchors, already trimmed and de-duplicated. */
  anchors: string[];
  /** Append a line to the run's streamed output. */
  log(line: string): void;
  /** True once the phone called the run off — checked between samples so a
   *  watch loop stops at a frame boundary rather than mid-write. */
  cancelled(): boolean;
}

/** One backend, open on one pass. */
export interface CaptureSession {
  /** Take one frame, writing the PNG to `absPath`. */
  frame(absPath: string): Promise<FrameResult>;
  /** Ask what is on the screen. `null` ⇒ there is nobody to ask, which caps the
   *  run at `stable` for ever. */
  oracle(): Promise<OracleReading | null>;
  /**
   * The advisory 0–100 for ONE frame, for a backend whose scorer is worth
   * calling only once.
   *
   * OPTIONAL, and most backends do not have it: a backend that learns a score
   * as a by-product of taking the frame reports it on `FrameResult` instead.
   * This exists for the other shape — ciqkit's `shot-score` is a python process
   * with numpy behind it, and the settle loop discards every sample but the
   * last, so scoring inside `frame()` bought a process start per throwaway
   * frame. The core calls this once, on the frame it KEPT.
   *
   * `null` ⇒ it could not be measured. That stays ABSENT in the sidecar and
   * prints `score n/a`; it is never 0.
   */
  score?(absPath: string): Promise<number | null>;
  /** Always called, including on failure. */
  end(): Promise<void>;
}

export interface CaptureBackend {
  id: CaptureBackendId;
  /**
   * Can this machine run this backend? `repoDir` matters because the answer is
   * repo-scoped for `web` — Playwright lives in the target repo's
   * `node_modules`, not this one's.
   */
  probe(repoDir?: string): Promise<CaptureBackendInfo>;
  /**
   * The in-process mutex key, or null for a backend that takes NO lease.
   * `garmin` is null on purpose: ciqkit runs its own broker with its own queue,
   * and a second lease held on this side would deadlock against it.
   */
  leaseKey(t: CaptureTarget): string | null;
  /** The refusal sentence for a half-configured target, or null to proceed. */
  validate(t: CaptureTarget): string | null;
  /** The frames one run of this target is. Never empty. */
  passes(t: CaptureTarget): CapturePass[];
  open(t: CaptureTarget, ctx: CaptureCtx): Promise<CaptureSession>;
}

// ── Playwright, as much of it as `capture/web.ts` touches ───────────────────

export interface PwPage {
  goto(url: string, opts?: unknown): Promise<unknown>;
  screenshot(opts: unknown): Promise<unknown>;
  content(): Promise<string>;
  evaluate(fn: unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  on(event: string, handler: (arg: any) => void): void;
  close(): Promise<void>;
}

export interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

export interface PwBrowser {
  newContext(opts?: unknown): Promise<PwContext>;
  close(): Promise<void>;
}

export interface PwModule {
  chromium: { launch(opts?: unknown): Promise<PwBrowser> };
}
