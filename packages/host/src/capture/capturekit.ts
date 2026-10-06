/**
 * The capture loop's knobs and its backend table — constants only, no logic.
 * Split out of `capture.ts` (move only); the numbers and their reasons are the
 * ones that were beside the manager.
 */
import { envName } from "@waterplane/shared";
import type { CaptureBackendId } from "@waterplane/shared";
import { env } from "../env.js";
import type { CaptureBackend } from "./types.js";
import { webBackend } from "./web.js";
import { androidBackend } from "./android.js";
import { garminBackend } from "./garmin.js";
import { windowBackend } from "./window.js";
import { sleep } from "../proc.js";

/** The kill switch. `.env.example` carries it; absent means on. */
export const ENABLED = env("CAPTURE") !== "0";
/** Said wherever a capture is refused because the host switched it off. */
export const OFF_TEXT = `capture is switched off on this host (${envName("CAPTURE")}=0).`;

export const DEFAULT_SETTLE_MS = 15_000;
/** A cap on the cap: a hand-edited `settleMs` must not wedge a lease for an hour. */
export const MAX_SETTLE_MS = 120_000;
/** How often the settle loop re-asks. Below a frame's own cost this is noise. */
export const SETTLE_SAMPLE_MS = 300;
export const DEFAULT_DIFF_PCT = 2;
export const WATCH_MAX_MS = 10 * 60_000;
export const WATCH_MAX_FRAMES = 60;
export const WATCH_INTERVAL_MS = 1_000;
/** Retained output per run (chars) — `builds.ts`'s ring, same reason. */
export const OUT_RING = 200_000;
/** Console/network lines kept in the sidecar for a whole RUN. The web backend
 *  caps its own per pass; this caps the sum over four of them, because the
 *  sidecar is a document somebody downloads over a phone tunnel. The COUNTS are
 *  never capped — only the quoted lines. */
export const MAX_SIDECAR_LINES = 40;
/** Runs a sheet renders per repo. The store keeps more and never drops one that
 *  has not settled. */
export const MAX_RUNS = 40;
/** How long a backend probe is believed. Long enough that opening the sheet
 *  does not re-shell four binaries per tap; short enough that installing
 *  Playwright shows up without a restart. */
export const PROBE_TTL_MS = 30_000;

export const BACKENDS: Record<CaptureBackendId, CaptureBackend> = {
  web: webBackend,
  android: androidBackend,
  garmin: garminBackend,
  window: windowBackend,
};

export { sleep };
