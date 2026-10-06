/**
 * Verified capture — "show me what that screen actually looks like right now,
 * and say how much the picture can be trusted".
 *
 * A capture is a BUILD with a picture at the end of it. That is not a metaphor:
 * the target is configured per repo in `.waterplane/capture.json` exactly as a build
 * is in `.waterplane/builds.json`, the run IS an intent (so `runId` is the intent id),
 * it streams output the same way, and the frames it writes land in
 * `.claude/outbox/` through the same `newOutboxPath` every other artifact uses.
 * Everything that is new here is the SECOND half — the claim the run is allowed
 * to make about the picture it took.
 *
 * ── The one rule this whole file is shaped by ──────────────────────────────
 *
 * A capture may only claim what it can demonstrate. The word "verified" is
 * reserved for an ORACLE reading — a backend that could go and ask the running
 * thing what text is on its screen and got an answer. A backend with no oracle
 * (a window grab; a screenshot of a simulator nobody can query) can reach
 * `stable` — two consecutive frames agreed — and can NEVER reach `anchor`, no
 * matter how good the picture is. One frame with nothing to compare it to is
 * `unverified`, and says so.
 *
 * The same rule governs every optional field below. `score` absent is the
 * canonical case: no scorer exists on this machine, so there is no number, and
 * `0` would read as "this screenshot is terrible" when the truth is "nobody
 * looked". Every `?` in `CaptureSidecar` means SOMETHING WAS NOT MEASURED, and
 * a reader must render the absence as words rather than substitute a zero.
 * (CLAUDE.md: "Heuristics degrade to null or absent, never to a wrong number.")
 *
 * ── And why availability is a sentence ─────────────────────────────────────
 *
 * `CaptureBackendInfo.reason` is prose, not a flag, because the phone's only
 * honest move when a backend is missing is to SAY so — the repo forbids greying
 * a control out to mean "not clickable" (`Unavailable.tsx`), and a `title`
 * attribute is invisible on a touch screen. "web needs Playwright — `npm i -D
 * playwright` in this repo" is a fix somebody can act on; a disabled button is
 * a dead end.
 */

import type { BuildArtifact } from "./work.js";

// ── What can be captured ────────────────────────────────────────────────────

/**
 * The four ways a frame can be obtained. Deliberately a closed set: an unknown
 * backend in a config file is REFUSED by name (naming these ids back) rather
 * than coerced into a default, because a target silently re-pointed at the
 * whole desktop would produce a perfectly valid-looking picture of the wrong
 * thing.
 */
export type CaptureBackendId = "web" | "android" | "garmin" | "window";

/** The known ids as a value, so the sanitizer's refusal, the doctor's detail
 *  line and the editor's picker cannot each carry their own copy of the list. */
export const CAPTURE_BACKEND_IDS: readonly CaptureBackendId[] = ["web", "android", "garmin", "window"];

/** A resolved colour scheme — what a frame was actually taken in. */
export type CaptureTheme = "light" | "dark";

/** What a target ASKS for. `both` means two frames per viewport, one each way;
 *  it is never a value a finished frame carries (see `CaptureSidecar.theme`). */
export type CaptureThemePref = CaptureTheme | "both";

/** Device-independent pixels of one frame. */
export interface CaptureViewport {
  w: number;
  h: number;
}

/** One phone-shaped frame — the default when a web target names no viewports.
 *  Shared so the host's frame and the sheet's label cannot disagree about what
 *  "the default" was. */
export const DEFAULT_CAPTURE_VIEWPORT: CaptureViewport = { w: 390, h: 844 };

/**
 * One named, runnable capture — the button. Persisted per repo in
 * `<repoDir>/.waterplane/capture.json`, the sibling of `builds.json`, and edited the
 * same way (the client owns the whole list and saves it whole).
 *
 * Backend-specific fields are all optional HERE and required by the BACKEND:
 * a `web` target with no `url` is kept in the file and refused with a sentence
 * when somebody runs it. Dropping the row instead would delete a
 * half-configured target the user is in the middle of writing, which is the
 * one thing an editor must never do.
 */
export interface CaptureTarget {
  /** Client-minted and stable, `BuildConfig.id`'s rule — a run row that renames
   *  itself after an edit is a lie about what ran. */
  id: string;
  /** Button label, e.g. "droplet · home". */
  name: string;
  backend: CaptureBackendId;
  /** Working dir RELATIVE to the repo root (traversal-guarded, `BuildConfig.dir`'s
   *  rule). Empty/absent = the repo root. A 16-app monorepo is 16 targets, each
   *  with its own `dir`. */
  dir?: string;
  /**
   * Text that must be on the screen for this capture to be believed.
   *
   * Non-empty is what makes `verification: "anchor"` REACHABLE — it is not what
   * makes it true. A backend with no oracle cannot confirm an anchor at all and
   * is capped at `stable` even with anchors set, and the sidecar records which
   * ones were wanted, found and missing rather than collapsing the three into a
   * boolean.
   */
  anchor?: string[];
  /** CAP on the wait for the screen to stop moving — never a fixed sleep. The
   *  run settles as soon as two frames agree; this is only how long it is
   *  willing to keep asking. */
  settleMs?: number;
  /** Watch mode's emit threshold: percent of pixels that must have changed
   *  before a new frame is worth a file. Absent = the module's default. With no
   *  pixel tool on the machine there is no measurement, so the gate degrades to
   *  "emit every frame, capped, and SAY that is what happened" — never to
   *  silently emitting nothing. */
  diffPct?: number;

  // ── web only ──
  /** REQUIRED for `web`. Loopback/host-local only. Capture never STARTS a dev
   *  server: a url that does not answer is a refusal in words naming the Build
   *  sheet as the way to start one. */
  url?: string;
  /** One frame per entry. Absent/empty ⇒ `DEFAULT_CAPTURE_VIEWPORT`. */
  viewports?: CaptureViewport[];
  /** Emulated `prefers-color-scheme`. Absent ⇒ the module's default. */
  theme?: CaptureThemePref;

  // ── android only ──
  /** Absent ⇒ the only connected device. More than one connected and no serial
   *  is a refusal in words, not a guess at which phone you meant. */
  serial?: string;

  // ── garmin only ──
  /** `ciqkit sim shot <screen>`. */
  screen?: string;
  /** `ciqkit --device <device>`. */
  device?: string;

  // ── window only ──
  /** Resolved best-effort; unresolvable ⇒ the whole desktop, which the sidecar
   *  records so the picture is never passed off as that window. */
  windowTitle?: string;
}

// ── What a run is ───────────────────────────────────────────────────────────

/** Where one capture run is. `BuildRunStatus`'s set, deliberately: a capture IS
 *  a build with a picture at the end, and two vocabularies for one lifecycle is
 *  two things that can drift. */
export type CaptureRunStatus = "running" | "done" | "failed" | "cancelled";

/**
 * How much the frame can be trusted.
 *
 * - `anchor` — an ORACLE was asked and the expected text was there. The only
 *   level that prints as "verified".
 * - `stable` — consecutive frames agreed, so nothing was mid-animation, mid-load
 *   or mid-paint. Prints as "settled". It is a claim about the SCREEN having
 *   stopped, never about the screen being right.
 * - `unverified` — one frame, nothing to compare it against, nobody asked.
 *
 * A backend with no oracle can never answer `anchor`, however many anchors the
 * target names. That ceiling is the point of the type.
 */
export type CaptureVerification = "anchor" | "stable" | "unverified";

/** The error overlays worth recognising by name — a frame of a red Vite box is
 *  a FAILED capture with a verdict, not a screenshot of the app. */
export type CaptureOverlayKind = "vite-hmr" | "next-error" | "react-boundary";

/**
 * One execution of a `CaptureTarget`.
 *
 * `runId` IS the intent id (`AssessRun`/`BuildRun`'s arrangement): the run is an
 * Intent with `target: shell`, so it is on disk before the tap returns, shows in
 * Activity while it works, and survives a restart. A second identifier for one
 * row is a second thing that can disagree.
 *
 * The verdict fields are a SUMMARY of the sidecar, carried on the run so the
 * phone can render a row without fetching and parsing a JSON file over a tunnel
 * that may be down. They are all optional because a run that is still going, or
 * that died before it took a frame, has nothing to summarise — and an absent
 * verdict must read as "not yet", not as "unverified".
 */
export interface CaptureRun {
  runId: string;
  /** The worktree this run belongs to and was run in. */
  repoDir: string;
  targetId: string;
  /** The target's name at fire time (the config may be edited later). */
  name: string;
  /**
   * Which backend took the picture — ABSENT when nobody recorded it.
   *
   * Optional for the same reason every other field here is: a run that has not
   * started, or that died before it wrote a sidecar, may have no record of its
   * backend at all (`cleanIntentRow` DROPS a backend it does not recognise, so
   * a hand-edited row can arrive without one). The only value that could be
   * substituted is a real backend id, and every one of them is a claim — the
   * old fallback said `window`, i.e. "this is a grab of the whole desktop",
   * about a run nobody could account for. Absence is rendered as words.
   */
  backend?: CaptureBackendId;
  /**
   * True when this run was started in WATCH mode — it keeps sampling one pass
   * for up to ten minutes, emitting only frames past the diff threshold.
   *
   * ABSENT rather than `false`, the same rule as `backend` above: a row written
   * before anything recorded this, or one whose payload could not be read, does
   * not know which kind of run it was, and a `false` there would tell a reader
   * that a ten-minute watch run is a capture that has hung. Absent reads as
   * "nobody wrote it down"; the phone treats only an explicit `true` as a watch.
   */
  watch?: boolean;
  status: CaptureRunStatus;
  /** Absent while running, and on a run that never got far enough to judge. */
  verification?: CaptureVerification;
  /** 0–100 advisory. ABSENT — never 0 — when no scorer exists on this machine. */
  score?: number;
  /** The one-line summary a person reads. Derived host-side from the sidecar by
   *  a single function, so the row, the sheet and the agent's HTTP answer cannot
   *  word it three ways. */
  verdict?: string;
  /** Worktree-relative path of the sidecar JSON (under `.claude/outbox/`). */
  sidecarRelPath?: string;
  /** The frames, as artifacts — the same records the gallery, the download
   *  button and auto-pull already understand. Reusing `BuildArtifact` rather
   *  than minting a capture-shaped twin is what makes a capture's output flow
   *  through every existing transport with no new code at either end. */
  files?: BuildArtifact[];
  startedAt: number;
  finishedAt?: number;
  /** Exit code once finished; null while running or on a signal kill.
   *  `BuildRun.exitCode`'s contract. */
  exitCode: number | null;
}

/**
 * Whether a backend can be used on THIS machine, and if not, what to say.
 *
 * Rides on the `capture.list` reply rather than being probed separately, so the
 * sheet has the sentence in hand at the moment it draws the button and never
 * has a window in which it must guess.
 */
export interface CaptureBackendInfo {
  id: CaptureBackendId;
  available: boolean;
  /**
   * A HUMAN SENTENCE, rendered as text by the phone — what is missing and what
   * would fix it ("web needs Playwright; `npm i -D playwright` in this repo").
   *
   * Present whenever `available` is false; a backend that is unavailable for no
   * stated reason is a dead button with no explanation, which is the thing
   * `Unavailable.tsx` exists to prevent. May also be present when `available` is
   * true, to say which tool was found.
   */
  reason?: string;
}

// ── What a run leaves behind ────────────────────────────────────────────────

/** One frame on disk. Written beside the sidecar under `.claude/outbox/`. */
export interface CaptureFile {
  /** FULL worktree-relative transport path, e.g.
   *  `.claude/outbox/capture-t_home-2026-09-13-a1b2.png` — the path the artifact
   *  endpoint takes and the path a report must quote whole. */
  relPath: string;
  /**
   * The PNG's OWN pixel dimensions — DEVICE pixels, read out of the file's
   * header. Absent rather than 0 when it would not parse.
   *
   * These are deliberately NOT `CaptureSidecar.viewport`, and one document
   * carrying both numbers is not two answers to one question. The web backend
   * renders at `deviceScaleFactor: 2`, so a frame asked for at a 390x844 CSS
   * viewport is an 780x1688 file: the viewport is what was REQUESTED in
   * device-independent pixels, `w`/`h` are what was WRITTEN. A reader quoting a
   * size to a person wants the viewport; a reader about to open the file wants
   * these.
   */
  w?: number;
  h?: number;
  /** The colour scheme this particular frame was taken in, when a `both` target
   *  produced one of each. */
  theme?: CaptureTheme;
}

/**
 * The JSON written beside the frames — the whole evidence record for one run.
 *
 * It is a `.json` in `.claude/outbox/`, which means it is already a document
 * the gallery lists, the badge counts and the phone can download, with no new
 * plumbing. It also means an AGENT can read the ~50-token verdict instead of
 * looking at a picture it cannot see.
 *
 * EVERY optional field below means "this was not measured". None of them may be
 * defaulted to `0`, `""` or `false` by a writer, and none of them may be read as
 * zero by a reader.
 */
export interface CaptureSidecar {
  /** Schema version of this document. */
  v: 1;
  /** The intent id — the same string as `CaptureRun.runId`. */
  runId: string;
  /** Enough of the target to read the record years later, snapshotted at fire
   *  time for `BuildPayload`'s reason: the config is edited between runs. */
  target: { id: string; name: string; backend: CaptureBackendId };
  startedAt: number;
  finishedAt: number;
  verification: CaptureVerification;
  /**
   * Which anchors were wanted, which were found and which were not. ABSENT when
   * the target named none — and ALSO when there was no oracle to ask at all (a
   * backend with none, or one whose reading could not be taken): nothing was
   * learned either way, and `verification` can never be `anchor` in either case.
   *
   * Present with a non-empty `missing` is the third, different fact: somebody
   * WAS asked and the text was not there. A page with no text at all answers
   * that way rather than silently, which is what keeps "asked, and there was
   * nothing on screen" apart from "nobody asked".
   *
   * Over a multi-pass run the lists are aggregated, not overwritten: `missing`
   * is the UNION across passes and `found` only holds anchors every pass saw,
   * because the run is worth what its weakest frame is worth.
   *
   * Three lists rather than a boolean because "two of the three strings were on
   * screen" is the reading somebody actually needs, and a boolean throws exactly
   * that away.
   */
  anchor?: { wanted: string[]; found: string[]; missing: string[] };
  /** 0–100 advisory quality score — the WEAKEST of the run's passes. ABSENT —
   *  not 0 — when no scorer exists. */
  score?: number;
  /**
   * The geometry the frames were ASKED for, in device-independent pixels — the
   * emulated viewport where the backend has one, and otherwise the PNG's own
   * pixel size. Not the same number as `files[].w`/`h` when the backend renders
   * at a scale factor; see `CaptureFile`.
   *
   * ABSENT when the backend could not report it (a whole-desktop grab whose
   * file would not parse). A run whose passes used DIFFERENT geometries records
   * the first pass's here and says so in `verdict`; `files[]` carries each
   * frame's own.
   */
  viewport?: CaptureViewport;
  /** ABSENT when unknown, which is every backend that does not emulate a colour
   *  scheme (android, garmin, window). A `both` run records the FIRST pass's
   *  here — `files[].theme` carries each frame's own. */
  theme?: CaptureTheme;
  /** How the settle went. `stableAfterMs` is ABSENT when the screen never
   *  settled — the frame was taken anyway, at the cap, and the level says so. */
  frames: { sampled: number; stableAfterMs?: number };
  /** ABSENT when the screen was clean. Present means the run FAILED with a
   *  verdict — and the frame is still written, because a failure whose evidence
   *  was deleted cannot be debugged from a phone. `text` is absent when the
   *  overlay was recognised but its message could not be read out. */
  errorOverlay?: { kind: CaptureOverlayKind; text?: string };
  /**
   * Web only, capped; ABSENT on every other backend — which is a different
   * statement from `{errors: 0}`, i.e. "we looked and it was clean".
   *
   * Counts are the SUM over every pass of the run, never the last pass's: a
   * dark pass that logged three errors followed by a clean light pass is not a
   * clean run, and recording only the second one printed `console: clean` over
   * the top of the errors.
   */
  console?: { errors: number; warnings: number; lines: string[] };
  /** Web only; ABSENT elsewhere, same distinction; summed the same way. */
  network?: { failed: number; lines: string[] };
  /**
   * Watch mode: how this frame differed from the one before it.
   *
   * ABSENT when there was no previous frame. Present with `changedPct` ABSENT
   * when there was one but no pixel tool on the machine could measure the
   * difference — `reason` then says so, and the verdict prints `diff: n/a`. A
   * measured 0.0 and an unmeasurable difference are not the same fact.
   */
  diff?: { againstRelPath: string; changedPct?: number; reason?: string };
  /** The frames this run wrote, by FULL transport path. Empty when it failed
   *  before taking one. */
  files: CaptureFile[];
  /** The one line a person (or an agent) reads instead of the picture. Derived
   *  from everything above by one host-side function. */
  verdict: string;
}
